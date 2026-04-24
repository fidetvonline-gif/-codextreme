import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { randomUUID } from 'crypto';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Supabase Client for Backend
  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  
  // Use service key if available and not a placeholder, otherwise use anon key
  const isPlaceholder = (key?: string) => !key || key.startsWith('your_') || key.includes('placeholder') || key === '';
  
  const finalKey = !isPlaceholder(supabaseServiceKey) ? supabaseServiceKey : supabaseAnonKey;
  const keyType = !isPlaceholder(supabaseServiceKey) ? 'SERVICE_ROLE' : 'ANON';

  if (!supabaseUrl || isPlaceholder(supabaseUrl)) {
    console.error('CRITICAL: Supabase URL is missing or placeholder. Admission submissions will fail.');
  }
  if (isPlaceholder(finalKey)) {
    console.error(`CRITICAL: Supabase ${keyType} Key is missing or placeholder. Admission submissions will fail.`);
  } else {
    console.log(`Supabase client initialized with ${keyType} key (starts with: ${finalKey?.substring(0, 5)}...)`);
  }
  
  const supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', finalKey || 'placeholder');

  // API Routes
  app.post('/api/submit-form', async (req, res) => {
    const { type, data } = req.body;
    const targetEmail = 'codextremeng@gmail.com';

    console.log(`Form submission received: type=${type}`, data);

    try {
      // 1. Save to Supabase (Optional fallback if table/column missing)
      const table = type === 'admission' ? 'students' : 'messages';
      
      // Filter data for students table to avoid "column does not exist" errors
      let dbData = { ...data };
      if (table === 'students') {
        const allowedColumns = ['id', 'name', 'email', 'course', 'status', 'created_at', 'student_id', 'password'];
        dbData = Object.keys(data)
          .filter(key => allowedColumns.includes(key))
          .reduce((obj, key) => {
            obj[key] = data[key];
            return obj;
          }, {} as any);
      }
      
      // Ensure id is provided if missing
      if (!dbData.id) {
        dbData.id = randomUUID();
      }

      const { data: insertedData, error: dbError } = await supabase
        .from(table)
        .insert([dbData])
        .select()
        .single();
      
      if (dbError) {
        console.warn(`Database Submission Warning for ${table}:`, JSON.stringify(dbError, null, 2));
        
        // Non-critical errors are those where the table or column simply doesn't exist in the current Supabase schema
        const isMissingSchemaError = dbError.message && (
          dbError.message.includes('does not exist') || 
          dbError.message.includes('not found') || 
          dbError.message.includes('relation')
        );
        
        if (table === 'students' && !isMissingSchemaError) {
           let errorMessage = dbError.message || 'Unknown error';
           if (errorMessage.includes('API key')) {
             errorMessage = 'Invalid Supabase API Key. Please check your environment variables in the Settings menu.';
           }
           console.error('Critical Database Error for students:', JSON.stringify(dbError, null, 2));
           return res.status(500).json({ error: `Database Error: ${errorMessage}` });
        }
        console.log(`Continuing despite non-critical DB error for ${table}`);
      }

      // 1.5. Save Payment Record if provided
      if (req.body.paymentData) {
        let pData = { ...req.body.paymentData };
        
        // Link to student if available
        if (insertedData) {
          pData.student_id = insertedData.id;
        }

        // Ensure payments table also has an id if it's required and missing
        if (!pData.id) {
          pData.id = `PAY-${randomUUID()}`;
        }

        const { error: pErr } = await supabase.from('payments').insert([pData]);
        if (pErr) console.warn('Payment record save failed in API:', pErr.message);
      }

      // 2. Send Email
      // NOTE: To send real emails, you need to provide SMTP credentials in .env
      // Example: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.ethereal.email',
        port: Number(process.env.SMTP_PORT) || 587,
        secure: false,
        auth: {
          user: process.env.SMTP_USER || 'placeholder@example.com',
          pass: process.env.SMTP_PASS || 'placeholder_pass',
        },
      });

      const subject = type === 'admission' ? 'New Admission Application' : 'New Contact Message';
      const htmlContent = `
        <h2>${subject}</h2>
        <pre>${JSON.stringify(data, null, 2)}</pre>
      `;

      // If credentials are provided, try to send
      if (process.env.SMTP_USER && process.env.SMTP_USER !== 'placeholder@example.com') {
        await transporter.sendMail({
          from: '"CodeXtreme System" <system@codextreme.ng>',
          to: targetEmail,
          subject: subject,
          html: htmlContent,
        });
      } else {
        console.log('--- EMAIL SIMULATION ---');
        console.log('To:', targetEmail);
        console.log('Subject:', subject);
        console.log('Content:', data);
        console.log('------------------------');
      }

      res.json({ success: true, data: insertedData });
    } catch (error) {
      console.error('Form Submission Error:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  app.post('/api/admin/create-student', async (req, res) => {
    const { name, email, phone, course, mode } = req.body;
    
    if (!name || !email) {
      return res.status(400).json({ error: 'Name and Email are required' });
    }
    
    try {
      const studentId = `CX-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
      const tempPassword = Math.random().toString(36).slice(-8);

      // 1. Save to Supabase
      const { data, error: dbError } = await supabase
        .from('students')
        .insert([{
          id: randomUUID(),
          name,
          email,
          course,
          student_id: studentId,
          password: tempPassword,
          status: 'Active',
          created_at: new Date().toISOString()
        }])
        .select();

      if (dbError) {
        console.error('Admin Create Student Error:', dbError.message || dbError);
        return res.status(500).json({ 
          error: dbError.message || 'Failed to create student record',
          details: dbError
        });
      }

      const createdStudent = data && data[0];
      if (!createdStudent) throw new Error('No data returned after student creation');

      // 1.5. Create Enrollment automatically if course is specified
      if (course) {
        try {
          const { data: courseObj } = await supabase.from('courses').select('id').eq('title', course).maybeSingle();
          if (courseObj) {
            await supabase.from('enrollments').insert([{
              id: randomUUID(),
              student_id: createdStudent.id,
              course_id: courseObj.id,
              progress: 0,
              enrolled_at: new Date().toISOString()
            }]);
          }
        } catch (enrollErr) {
          console.warn('Auto-enrollment failed during student creation:', enrollErr);
        }
      }

      // 2. Send Email
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.ethereal.email',
        port: Number(process.env.SMTP_PORT) || 587,
        secure: false,
        auth: {
          user: process.env.SMTP_USER || 'placeholder@example.com',
          pass: process.env.SMTP_PASS || 'placeholder_pass',
        },
      });

      const subject = 'Welcome to CodeXtreme ICT Academy - Your Portal Credentials';
      const htmlContent = `
        <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
          <h2 style="color: #000;">Welcome, ${name}!</h2>
          <p>Your student portal account has been created successfully. You can now log in to access your course content and track your progress.</p>
          
          <div style="background: #f9f9f9; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 0; font-size: 14px; color: #666;">Login URL: <a href="${req.headers.origin}/portal" style="color: #000; font-weight: bold;">${req.headers.origin}/portal</a></p>
            <p style="margin: 10px 0 0 0; font-size: 14px; color: #666;">Student ID: <strong style="color: #000;">${studentId}</strong></p>
            <p style="margin: 5px 0 0 0; font-size: 14px; color: #666;">Temporary Password: <strong style="color: #000;">${tempPassword}</strong></p>
          </div>
          
          <p style="font-size: 12px; color: #999;">Please change your password after your first login for security.</p>
          <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
          <p style="font-size: 12px; color: #999;">CodeXtreme ICT Academy Support Team</p>
        </div>
      `;

      if (process.env.SMTP_USER && process.env.SMTP_USER !== 'placeholder@example.com') {
        await transporter.sendMail({
          from: '"CodeXtreme Academy" <noreply@codextreme.ng>',
          to: email,
          subject: subject,
          html: htmlContent,
        });
      } else {
        console.log('--- CREDENTIALS EMAIL SIMULATION ---');
        console.log('To:', email);
        console.log('Subject:', subject);
        console.log('Credentials:', { studentId, tempPassword });
        console.log('------------------------------------');
      }

      res.json({ success: true, student: createdStudent });
    } catch (error) {
      console.error('Create Student Error:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  app.get('/api/admin/create-student', (req, res) => {
    res.status(405).json({ error: 'Method Not Allowed. This endpoint requires a POST request with student data.' });
  });


  app.post('/api/admin/activate-portal', async (req, res) => {
    const { id, name, email } = req.body;
    
    try {
      const studentId = `CX-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
      const tempPassword = Math.random().toString(36).slice(-8);

      // 2. Update Supabase
      const { data, error: dbError } = await supabase
        .from('students')
        .update({ 
          student_id: studentId, 
          password: tempPassword,
          status: 'Active'
        })
        .eq('id', id)
        .select();

      if (dbError) {
        console.error('Activate Portal DB Error:', dbError.message || dbError);
        return res.status(500).json({ 
          error: dbError.message || 'Failed to update student record',
          details: dbError
        });
      }

      const updatedStudent = data && data[0];
      if (!updatedStudent) throw new Error('No data returned after activation');

      // 2.5. Create Enrollment automatically if student has a course title
      if (updatedStudent.course && updatedStudent.course !== 'N/A') {
        try {
          const { data: courseObj } = await supabase.from('courses').select('id').eq('title', updatedStudent.course).maybeSingle();
          if (courseObj) {
            // Check if already enrolled to avoid duplicates
            const { data: existingEnroll } = await supabase
              .from('enrollments')
              .select('id')
              .eq('student_id', updatedStudent.id)
              .eq('course_id', courseObj.id)
              .maybeSingle();

            if (!existingEnroll) {
              await supabase.from('enrollments').insert([{
                id: randomUUID(),
                student_id: updatedStudent.id,
                course_id: courseObj.id,
                progress: 0,
                enrolled_at: new Date().toISOString()
              }]);
            }
          }
        } catch (enrollErr) {
          console.warn('Auto-enrollment failed during portal activation:', enrollErr);
        }
      }

      // 3. Send Email
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.ethereal.email',
        port: Number(process.env.SMTP_PORT) || 587,
        secure: false,
        auth: {
          user: process.env.SMTP_USER || 'placeholder@example.com',
          pass: process.env.SMTP_PASS || 'placeholder_pass',
        },
      });

      const subject = 'Your CodeXtreme Portal Access is Ready';
      const htmlContent = `
        <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
          <h2 style="color: #000;">Hello, ${name}!</h2>
          <p>Your student portal access has been activated. You can now log in to access your course content and track your progress.</p>
          
          <div style="background: #f9f9f9; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 0; font-size: 14px; color: #666;">Login URL: <a href="${req.headers.origin}/portal" style="color: #000; font-weight: bold;">${req.headers.origin}/portal</a></p>
            <p style="margin: 10px 0 0 0; font-size: 14px; color: #666;">Student ID: <strong style="color: #000;">${studentId}</strong></p>
            <p style="margin: 5px 0 0 0; font-size: 14px; color: #666;">Temporary Password: <strong style="color: #000;">${tempPassword}</strong></p>
          </div>
          
          <p style="font-size: 12px; color: #999;">Please change your password after your first login for security.</p>
          <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
          <p style="font-size: 12px; color: #999;">CodeXtreme ICT Academy Support Team</p>
        </div>
      `;

      if (process.env.SMTP_USER && process.env.SMTP_USER !== 'placeholder@example.com') {
        await transporter.sendMail({
          from: '"CodeXtreme Academy" <noreply@codextreme.ng>',
          to: email,
          subject: subject,
          html: htmlContent,
        });
      }

      res.json({ success: true, student: updatedStudent });
    } catch (error) {
      console.error('Activate Portal Error:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  app.post('/api/student/register', async (req, res) => {
    const { name, email, phone } = req.body;
    
    try {
      // 1. Check if email already exists
      const { data: existing } = await supabase.from('students').select('id').eq('email', email).maybeSingle();
      if (existing) {
        return res.status(400).json({ error: 'Email already registered' });
      }

      const studentId = `CX-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
      const tempPassword = Math.random().toString(36).slice(-8);

      // 2. Insert Student
      const { data, error: dbError } = await supabase
        .from('students')
        .insert([{
          id: randomUUID(),
          name,
          email,
          course: 'N/A',
          student_id: studentId,
          password: tempPassword,
          status: 'Active',
          created_at: new Date().toISOString()
        }])
        .select();

      if (dbError) {
        console.error('Registration DB Error:', dbError.message || dbError);
        return res.status(400).json({ 
          error: dbError.message || 'Database registration failed',
          details: dbError,
          code: dbError.code
        });
      }

      const createdStudent = data && data[0];
      if (!createdStudent) throw new Error('No data returned after registration');

      // 3. Send Credentials Email
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.ethereal.email',
        port: Number(process.env.SMTP_PORT) || 587,
        secure: false,
        auth: {
          user: process.env.SMTP_USER || 'placeholder@example.com',
          pass: process.env.SMTP_PASS || 'placeholder_pass',
        },
      });

      const subject = 'Welcome to CodeXtreme ICT Academy - Your Account is Ready';
      const htmlContent = `
        <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
          <h2 style="color: #000;">Welcome, ${name}!</h2>
          <p>Your student account has been created. You can now log in to the portal to enroll in courses and start learning.</p>
          
          <div style="background: #f9f9f9; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 0; font-size: 14px; color: #666;">Login URL: <a href="${req.headers.origin}/portal" style="color: #000; font-weight: bold;">${req.headers.origin}/portal</a></p>
            <p style="margin: 10px 0 0 0; font-size: 14px; color: #666;">Student ID: <strong style="color: #000;">${studentId}</strong></p>
            <p style="margin: 5px 0 0 0; font-size: 14px; color: #666;">Temporary Password: <strong style="color: #000;">${tempPassword}</strong></p>
          </div>
          <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
          <p style="font-size: 12px; color: #999;">CodeXtreme ICT Academy Support Team</p>
        </div>
      `;

      if (process.env.SMTP_USER && process.env.SMTP_USER !== 'placeholder@example.com') {
        await transporter.sendMail({
          from: '"CodeXtreme Academy" <noreply@codextreme.ng>',
          to: email,
          subject: subject,
          html: htmlContent,
        });
      }

      res.json({ success: true, student: createdStudent });
    } catch (error) {
      console.error('Registration Error:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  app.post('/api/student/onboard', async (req, res) => {
    // This is for Admission form auto-onboarding after payment
    const { name, email, phone, course, mode, payment_ref } = req.body;
    
    try {
      // 1. Check if email exists
      let studentIdValue;
      let passwordValue;
      let studentRecord;

      const { data: existing } = await supabase.from('students').select('*').eq('email', email).maybeSingle();
      
      if (existing && existing.student_id) {
        // Already has an account
        studentRecord = existing;
      } else if (existing) {
        // Record exists but no portal access
        studentIdValue = `CX-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
        passwordValue = Math.random().toString(36).slice(-8);
        const { data } = await supabase.from('students').update({
          student_id: studentIdValue,
          password: passwordValue,
          status: 'Active'
        }).eq('id', existing.id).select().single();
        studentRecord = data;
      } else {
        // Brand new
        studentIdValue = `CX-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
        passwordValue = Math.random().toString(36).slice(-8);
        const { data } = await supabase.from('students').insert([{
          id: randomUUID(),
          name, email, course,
          student_id: studentIdValue,
          password: passwordValue,
          status: 'Active',
          created_at: new Date().toISOString()
        }]).select().single();
        studentRecord = data;
      }

      // 2. Create Enrollment
      // First find course id
      try {
        const { data: courseObj } = await supabase.from('courses').select('id').eq('title', course).maybeSingle();
        if (courseObj && studentRecord) {
          const { error: enrollError } = await supabase.from('enrollments').insert([{
            id: randomUUID(),
            student_id: studentRecord.id,
            course_id: courseObj.id,
            progress: 0,
            enrolled_at: new Date().toISOString()
          }]);
          if (enrollError) {
            console.warn('Enrollment creation skipped:', enrollError.message);
          }
        }
      } catch (enrollErr) {
        console.warn('Enrollment process warning:', enrollErr);
      }

      // 3. Send Email
      if (studentIdValue && passwordValue) {
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST || 'smtp.ethereal.email',
          port: Number(process.env.SMTP_PORT) || 587,
          secure: false,
          auth: { user: process.env.SMTP_USER || 'placeholder', pass: process.env.SMTP_PASS || 'placeholder' },
        });

        const subject = 'Welcome to CodeXtreme! Your Course is Ready';
        const htmlContent = `
          <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
            <h2 style="color: #000;">Congratulations, ${name}!</h2>
            <p>Your payment for <strong>${course}</strong> was successful. We have created your student portal account.</p>
            
            <div style="background: #f9f9f9; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <p>Student ID: <strong>${studentIdValue}</strong></p>
              <p>Password: <strong>${passwordValue}</strong></p>
              <p>Login URL: <a href="${req.headers.origin}/portal">${req.headers.origin}/portal</a></p>
            </div>
            <p>You can now start learning immediately!</p>
          </div>
        `;
        
        if (process.env.SMTP_USER && process.env.SMTP_USER !== 'placeholder@example.com') {
           await transporter.sendMail({ from: '"CodeXtreme" <noreply@codextreme.ng>', to: email, subject, html: htmlContent });
        }
      }

      res.json({ success: true, student: studentRecord });
    } catch (error) {
      console.error('Onboarding Error:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  app.get('/api/public/course/:id', async (req, res) => {
    const { id } = req.params;
    try {
      const { data, error } = await supabase
        .from('courses')
        .select('*')
        .eq('id', id)
        .maybeSingle();

      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Course not found' });

      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/public/data', async (req, res) => {
    try {
      const fetchCourses = supabase.from('courses').select('*').eq('status', 'Published');
      const fetchTestimonials = supabase.from('testimonials').select('*');
      const fetchGallery = supabase.from('gallery').select('*').order('created_at', { ascending: false }).limit(20);
      const fetchEvents = supabase.from('events').select('*').order('date', { ascending: true });
      const fetchSettings = supabase.from('settings').select('*').eq('id', 'global').maybeSingle();
      const fetchTeam = supabase.from('leadership').select('*');

      const [
        { data: courses },
        { data: testimonials },
        { data: gallery },
        { data: events },
        { data: settings },
        { data: team }
      ] = await Promise.all([
        fetchCourses,
        fetchTestimonials,
        fetchGallery,
        fetchEvents,
        fetchSettings,
        fetchTeam
      ]);

      res.json({
        courses: courses || [],
        testimonials: testimonials || [],
        gallery: gallery || [],
        events: events || [],
        settings: settings || null,
        team: team || []
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/certificate/verify', async (req, res) => {
    const { certId } = req.query;
    if (!certId) return res.status(400).json({ error: 'Certificate ID required' });

    try {
      const { data, error } = await supabase
        .from('certificates')
        .select('*')
        .eq('certificate_id', certId as string)
        .maybeSingle();

      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Certificate not found or invalid ID.' });

      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/student/login', async (req, res) => {
    const { studentId, password } = req.body;

    // Hardcoded Demo Account (robust check)
    if (studentId?.trim().toUpperCase() === 'STU/101' && password?.trim() === 'password123') {
      return res.json({ 
        success: true, 
        student: {
          id: 'demo-uuid',
          name: 'Demo Student',
          email: 'demo@example.com',
          student_id: 'STU/101',
          password: 'password123',
          course: 'Full-Stack Web Development',
          status: 'Active',
          created_at: new Date().toISOString()
        }
      });
    }

    try {
      const { data, error } = await supabase
        .from('students')
        .select('*')
        .eq('student_id', studentId?.trim())
        .eq('password', password?.trim())
        .maybeSingle();

      if (error) throw error;
      if (!data) return res.status(401).json({ error: 'Invalid Student ID or Password' });

      res.json({ success: true, student: data });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put('/api/admin/reset-student-password', async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Student ID required' });

    try {
      const newPassword = Math.random().toString(36).slice(-8);
      const { error } = await supabase
        .from('students')
        .update({ password: newPassword })
        .eq('id', id);

      if (error) throw error;
      res.json({ success: true, newPassword });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/student/course-content', async (req, res) => {
    const { courseName } = req.query;
    if (!courseName) return res.status(400).json({ error: 'Course name required' });

    try {
      // 1. Get Course ID
      const { data: courseData, error: cErr } = await supabase
        .from('courses')
        .select('id')
        .eq('title', courseName as string)
        .maybeSingle();

      if (cErr) throw cErr;
      if (!courseData) return res.json({ modules: [], lessons: [] });

      // 2. Fetch Modules
      const { data: modulesData, error: mErr } = await supabase
        .from('lms_modules')
        .select('*')
        .eq('course_id', courseData.id)
        .order('order_index', { ascending: true });

      if (mErr) throw mErr;

      // 3. Fetch Lessons
      let lessonsData: any[] = [];
      if (modulesData && modulesData.length > 0) {
        const { data: lData, error: lErr } = await supabase
          .from('lms_lessons')
          .select('*')
          .in('module_id', modulesData.map(m => m.id))
          .order('order_index', { ascending: true });
        
        if (lErr) throw lErr;
        lessonsData = lData || [];
      }

      res.json({
        modules: modulesData || [],
        lessons: lessonsData
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/student/portal-data', async (req, res) => {
    const { student_id } = req.query; // This is the UUID 'id' column from students table
    
    if (!student_id) return res.status(400).json({ error: 'Student ID required' });

    // Handle Demo Student Mock Data
    if (student_id === 'demo-uuid') {
      try {
        const { data: courses } = await supabase.from('courses').select('*').eq('status', 'Published');
        // Give demo student a mock enrollment in the first course found
        const mockEnrollments = courses && courses.length > 0 ? [{
          id: 'mock-enroll-id',
          student_id: 'demo-uuid',
          course_id: courses[0].id,
          progress: 45,
          enrolled_at: new Date().toISOString(),
          courses: courses[0]
        }] : [];

        const mockPayments = [{
          id: 'mock-pay-1',
          student_id: 'demo-uuid',
          amount: 50000,
          purpose: 'Tuition Fee (Installment)',
          status: 'Successful',
          method: 'Card',
          created_at: new Date().toISOString()
        }];

        const mockCertificates = [];

        return res.json({
          courses: courses || [],
          enrollments: mockEnrollments,
          payments: mockPayments,
          certificates: mockCertificates,
          notifications: [
            { id: 1, title: 'Welcome to the Portal', message: 'Explore your dashboard and start learning.', created_at: new Date().toISOString() }
          ]
        });
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    }

    try {
      const fetchWithCatch = async (query: any, label: string) => {
        try {
          const result = await query;
          if (result.error) {
            console.error(`Supabase Error [${label}]:`, JSON.stringify(result.error, null, 2));
            return { data: [] };
          }
          return result;
        } catch (err) {
          console.error(`Fetch Fallback [${label}]:`, err);
          return { data: [] };
        }
      };

      const [
        { data: courses },
        { data: enrollments },
        { data: payments },
        { data: certificates }
      ] = await Promise.all([
        fetchWithCatch(supabase.from('courses').select('*').eq('status', 'Published'), 'published_courses'),
        fetchWithCatch(supabase.from('enrollments').select('*, courses(*)').eq('student_id', student_id), 'student_enrollments'),
        fetchWithCatch(supabase.from('payments').select('*').eq('student_id', student_id).order('created_at', { ascending: false }), 'student_payments'),
        fetchWithCatch(supabase.from('certificates').select('*').eq('student_id', student_id).order('created_at', { ascending: false }), 'student_certificates')
      ]);

      res.json({
        courses: courses || [],
        enrollments: enrollments || [],
        payments: payments || [],
        certificates: certificates || [],
        notifications: [
          { id: 1, title: 'Portal Activated', message: 'Your account is now ready for use.', created_at: new Date().toISOString() }
        ]
      });
    } catch (error: any) {
      console.error('Portal Data Fetch Error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.put('/api/student/update-settings', async (req, res) => {
    const { id, name, newPassword } = req.body;
    if (!id) return res.status(400).json({ error: 'Student ID required' });

    try {
      const updates: any = {};
      if (name) updates.name = name;
      if (newPassword) updates.password = newPassword;

      const { data, error } = await supabase
        .from('students')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      res.json({ success: true, student: data });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.route('/api/student/enroll')
    .get(async (req, res) => {
      const { student_id, course_id } = req.query;
      console.log(`[DEBUG] GET /api/student/enroll: student_id=${student_id}, course_id=${course_id}`);
      
      try {
        if (student_id && course_id) {
          const { data, error } = await supabase
            .from('enrollments')
            .select('*')
            .eq('student_id', student_id)
            .eq('course_id', course_id)
            .maybeSingle();
          
          if (error) throw error;
          return res.json({ enrolled: !!data, enrollment: data });
        }
        
        if (student_id) {
          const { data, error } = await supabase
            .from('enrollments')
            .select('*, courses(*)')
            .eq('student_id', student_id);
          
          if (error) throw error;
          return res.json({ enrollments: data || [] });
        }

        // If no student_id is provided, just return an empty list instead of a 400 error
        return res.json({ enrollments: [], message: 'No student_id provided' });
      } catch (error: any) {
        console.error('[DEBUG] GET /api/student/enroll error:', error);
        res.status(500).json({ error: error.message });
      }
    })
    .post(async (req, res) => {
      const { student_id, course_id } = req.body;
      console.log(`[DEBUG] POST /api/student/enroll: body=`, { student_id, course_id });

      try {
        if (!student_id || !course_id) {
          console.warn('[DEBUG] POST /api/student/enroll: Missing body data');
          return res.status(400).json({ error: 'Missing student_id or course_id in enrollment request' });
        }

        // Check if already enrolled to prevent duplicates
        const { data: existing, error: checkError } = await supabase
          .from('enrollments')
          .select('id')
          .eq('student_id', student_id)
          .eq('course_id', course_id)
          .maybeSingle();
        
        if (checkError) throw checkError;
        if (existing) {
          return res.status(400).json({ error: 'Already enrolled in this course' });
        }

        const { error: insertError } = await supabase.from('enrollments').insert([{
          id: randomUUID(),
          student_id,
          course_id,
          progress: 0,
          enrolled_at: new Date().toISOString()
        }]);

        if (insertError) {
          console.error('[DEBUG] Supabase Enrollment Insertion Error:', insertError);
          throw insertError;
        }
        
        console.log(`[DEBUG] Enrollment successful for student ${student_id} in course ${course_id}`);
        return res.json({ success: true });
      } catch (error: any) {
        console.error('[DEBUG] POST /api/student/enroll error:', error);
        res.status(500).json({ error: error.message });
      }
    });

  // Admin Data Fetch (Bypass RLS)
  app.get("/api/admin/data", async (req, res) => {
    try {
      const fetchWithCatch = async (query: any, label: string) => {
        try {
          const result = await query;
          if (result.error) {
            console.error(`Supabase Error [${label}]:`, JSON.stringify(result.error, null, 2));
            return { data: [] };
          }
          return result;
        } catch (err) {
          console.error(`Fetch Fallback [${label}]:`, err);
          return { data: [] };
        }
      };

      const [
        { data: courses },
        { data: eventsData },
        { data: students },
        { data: payments },
        { data: testimonialsData },
        { data: team },
        { data: messages },
        { data: certificates },
        { data: gallery },
        { data: settings },
        { data: enrollments }
      ] = await Promise.all([
        fetchWithCatch(supabase.from('courses').select('*'), 'courses'),
        fetchWithCatch(supabase.from('events').select('*'), 'events'),
        fetchWithCatch(supabase.from('students').select('*').order('created_at', { ascending: false }), 'students'),
        fetchWithCatch(supabase.from('payments').select('*').order('created_at', { ascending: false }), 'payments'),
        fetchWithCatch(supabase.from('testimonials').select('*'), 'testimonials'),
        fetchWithCatch(supabase.from('leadership').select('*'), 'leadership'),
        fetchWithCatch(supabase.from('messages').select('*').order('created_at', { ascending: false }), 'messages'),
        fetchWithCatch(supabase.from('certificates').select('*').order('created_at', { ascending: false }), 'certificates'),
        fetchWithCatch(supabase.from('gallery').select('*').order('created_at', { ascending: false }), 'gallery'),
        fetchWithCatch(supabase.from('settings').select('*'), 'settings'),
        fetchWithCatch(supabase.from('enrollments').select('*, students(name, email), courses(title)'), 'enrollments')
      ]);

      res.json({
        courses: courses || [],
        events: eventsData || [],
        students: students || [],
        payments: payments || [],
        testimonials: testimonialsData || [],
        team: team || [],
        messages: messages || [],
        certificates: certificates || [],
        gallery: gallery || [],
        settings: settings?.[0] || null,
        enrollments: enrollments || []
      });
    } catch (error: any) {
      console.error('Admin Data Fetch Error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // 404 handler for API routes ONLY
  app.all('/api/*', (req, res) => {
    console.warn(`API Route Not Found: ${req.method} ${req.url}`);
    res.status(404).json({ error: `API route ${req.method} ${req.url} not found` });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
