const nodemailer = require('nodemailer');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '.env') });

async function testSMTP() {
  console.log('--- SMTP Diagnostic Tool ---');
  console.log('User:', process.env.SMTP_USER);
  console.log('Host:', process.env.SMTP_HOST);
  console.log('Port:', process.env.SMTP_PORT);
  console.log('Secure:', process.env.SMTP_SECURE);
  
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: {
      rejectUnauthorized: false
    }
  });

  try {
    console.log('Verifying connection...');
    await transporter.verify();
    console.log('✅ Connection verified successfully!');
    
    console.log('Attempting to send test email...');
    await transporter.sendMail({
      from: `"Diagnostic" <${process.env.SMTP_USER}>`,
      to: process.env.SMTP_USER,
      subject: 'SMTP Test',
      text: 'If you see this, SMTP is working correctly.'
    });
    console.log('✅ Test email sent successfully!');
  } catch (error) {
    console.error('❌ SMTP Error:', error);
  }
}

testSMTP();
