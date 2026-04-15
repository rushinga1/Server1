const express = require('express')
const cors = require('cors')
const dotenv = require('dotenv')
const nodemailer = require('nodemailer')
const { PrismaClient } = require('@prisma/client')
const { Pool } = require('pg')
const { PrismaPg } = require('@prisma/adapter-pg')
const dns = require('dns')

// FORCE IPv4 to avoid ENETUNREACH errors on cloud platforms like Render
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first')
}

dotenv.config()

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })
const PORT = process.env.PORT || 4000
console.log('--- SERVER STARTUP ---')
console.log('PORT:', PORT)
console.log('DATABASE_URL present:', !!process.env.DATABASE_URL)
console.log('SMTP_USER:', process.env.SMTP_USER)
console.log('--- END STARTUP ---')

const app = express()

// GLOBAL LOGGING MIDDLEWARE
app.use((req, res, next) => {
  console.log(`>>> ${req.method} ${req.url} from ${req.ip}`)
  next()
})

app.use(express.json())
app.use(cors({
  origin: '*', // Allow all origins for local development
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
}))

// --- Nodemailer Setup ---
const smtpUser = process.env.SMTP_USER || ''
const smtpHost = process.env.SMTP_HOST || (smtpUser.toLowerCase().endsWith('@gmail.com') ? 'smtp.gmail.com' : '')
const smtpPort = Number(process.env.SMTP_PORT || 587)
const smtpSecure = process.env.SMTP_SECURE === 'true'

if (!smtpHost) {
  console.warn('[SMTP] SMTP_HOST is missing. Set SMTP_HOST in .env (e.g., smtp.gmail.com).')
}

const transporter = nodemailer.createTransport({
  host: smtpHost,
  port: smtpPort,
  secure: smtpSecure,
  auth: {
    user: smtpUser,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: false
  },
  debug: true,
  logger: true,
  connectionTimeout: 10000, // 10 seconds
  greetingTimeout: 10000,
  socketTimeout: 10000
})

// In-memory OTP store
const otpStore = new Map()
const OTP_EXPIRY_MS = 5 * 60 * 1000 // 5 minutes

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

// ============================================================
// AUTH & OTP ROUTES
// ============================================================
app.post('/api/otp/send', async (req, res) => {
  const { email } = req.body
  console.log(`[OTP] Request received for: ${email}`)
  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ success: false, message: 'A valid email address is required.' })
  }
  const normalizedEmail = email.toLowerCase().trim()

  // --- NEW: Check if user exists in DB first ---
  try {
    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } })
    console.log(`[OTP] User found: ${user ? 'Yes' : 'No'}`)
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'This email is not registered in our system. Please contact your worker for registration.' 
      })
    }
  } catch (err) {
    console.error('Database error during OTP check:', err)
    return res.status(500).json({ success: false, message: 'Internal server error.' })
  }

  console.log(`[OTP] Generating OTP for ${normalizedEmail}...`)
  const otp = generateOTP()
  const expiresAt = Date.now() + OTP_EXPIRY_MS
  otpStore.set(normalizedEmail, { otp, expiresAt })

  console.log(`[OTP] Attempting to send mail to ${normalizedEmail}...`)
  try {
    await transporter.sendMail({
      from: `"Agruni Portal" <${process.env.SMTP_USER}>`,
      to: normalizedEmail,
      subject: 'Your Agruni Verification Code',
      text: `Your AGRUNI verification code is: ${otp}\n\nIt is valid for 5 minutes. Do not share this code with anyone.`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; color: #333;">
          <h2 style="color: #1e40af;">Agruni Verification</h2>
          <p>Please use the following 6-digit code to complete your sign in:</p>
          <div style="background: #f1f5f9; padding: 15px; text-align: center; font-size: 28px; font-weight: bold; letter-spacing: 5px; color: #1e40af; border-radius: 8px;">
            ${otp}
          </div>
          <p style="margin-top: 20px;">This code is valid for <strong>5 minutes</strong>. If you did not request this, you can safely ignore this email.</p>
        </div>
      `
    })
    console.log(`[OTP] Sent to ${normalizedEmail}`)
    return res.json({ success: true, message: 'OTP sent successfully.' })
  } catch (error) {
    console.error('[OTP] CRITICAL ERROR details:', {
      message: error.message,
      code: error.code,
      command: error.command,
      stack: error.stack
    })
    return res.status(500).json({ success: false, message: 'Failed to send email. Please try again or check your SMTP settings.' })
  }
})

app.post('/api/otp/verify', async (req, res) => {
  const { email, otp } = req.body
  if (!email || !otp) {
    return res.status(400).json({ success: false, message: 'Email and OTP are required.' })
  }
  const normalizedEmail = email.toLowerCase().trim()
  const record = otpStore.get(normalizedEmail)

  if (!record) {
    return res.status(400).json({ success: false, message: 'No OTP found. Please request a new one.' })
  }
  if (Date.now() > record.expiresAt) {
    otpStore.delete(normalizedEmail)
    return res.status(400).json({ success: false, message: 'OTP has expired. Please request a new one.' })
  }
  if (record.otp !== otp) {
    return res.status(400).json({ success: false, message: 'Incorrect code. Please try again.' })
  }

  // Valid! Clear the OTP.
  otpStore.delete(normalizedEmail)
  
  // Find the existing user
  const user = await prisma.user.findUnique({ 
    where: { email: normalizedEmail },
    include: { registeredBy: true }
  })
  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found after verification.' })
  }

  console.log(`[OTP] Verified for ${normalizedEmail}`)
  return res.json({ success: true, message: 'Email verified successfully.', user })
})

// ============================================================
// USERS API
// ============================================================
app.get('/api/users/me', async (req, res) => {
  const { email } = req.query
  if (!email) return res.status(400).json({ error: 'Email query parameter required' })
  const user = await prisma.user.findUnique({ 
    where: { email: String(email) },
    include: { registeredBy: true }
  })
  if (!user) return res.status(404).json({ error: 'User not found' })
  res.json(user)
})

app.put('/api/users/me', async (req, res) => {
  const { email, name, phone } = req.body
  if (!email) return res.status(400).json({ error: 'Email body parameter required' })
  const user = await prisma.user.update({
    where: { email },
    data: { name, phone }
  })
  res.json(user)
})

// ============================================================
// ANNOUNCEMENTS API
// ============================================================
app.get('/api/announcements', async (req, res) => {
  try {
    const announcements = await prisma.announcement.findMany({
      orderBy: { date: 'desc' }
    });
    res.json(announcements);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch announcements' });
  }
})

app.post('/api/announcements', async (req, res) => {
  const { title, content, type, author } = req.body;
  try {
    const announcement = await prisma.announcement.create({
      data: {
        title,
        content,
        type: type || 'info',
        author: author || 'System Admin'
      }
    });
    res.json(announcement);
  } catch (err) {
    console.error('Error creating announcement:', err);
    res.status(500).json({ error: 'Failed to create announcement' });
  }
})

// ============================================================
// PAYMENTS API
// ============================================================
app.get('/api/payments', async (req, res) => {
  const { userId } = req.query
  const filter = userId ? { userId: String(userId) } : {}
  const payments = await prisma.payment.findMany({
    where: filter,
    orderBy: { date: 'desc' }
  })
  res.json(payments)
})

app.post('/api/payments', async (req, res) => {
  const { amount, service, method, userId } = req.body
  const payment = await prisma.payment.create({
    data: {
      amount: parseFloat(amount),
      service,
      method,
      status: 'completed',
      userId: userId ? String(userId) : null
    }
  })
  res.json(payment)
})

// ============================================================
// REMINDERS API
// ============================================================
app.get('/api/reminders', async (req, res) => {
  const { userId } = req.query
  const filter = userId ? { userId: String(userId) } : {}
  const reminders = await prisma.reminder.findMany({
    where: filter,
    orderBy: { date: 'asc' }
  })
  res.json(reminders)
})

app.post('/api/reminders', async (req, res) => {
  const { title, description, date, type, recurring, priority, userId } = req.body
  const reminder = await prisma.reminder.create({
    data: {
      title,
      description,
      date: new Date(date),
      type,
      recurring,
      priority,
      userId: userId ? String(userId) : null
    }
  })
  res.json(reminder)
})

app.delete('/api/reminders/:id', async (req, res) => {
  const { id } = req.params
  try {
    await prisma.reminder.delete({ where: { id } })
    res.json({ success: true })
  } catch (err) {
    res.status(400).json({ error: 'Failed to delete reminder' })
  }
})

// ============================================================
// WORKER API (Shared)
// ============================================================

// Register a new customer
app.post('/api/worker/register-customer', async (req, res) => {
  const { 
    firstName, lastName, phone, email, 
    district, sector, cell, village, 
    houseNumber, category, workerId 
  } = req.body

  try {
    const user = await prisma.user.create({
      data: {
        firstName,
        lastName,
        name: `${firstName} ${lastName}`,
        phone,
        email: email || null,
        district,
        sector,
        cell,
        village,
        houseNumber,
        category,
        role: "client",
        registeredById: workerId
      }
    })
    res.json(user)
  } catch (err) {
    console.error('Registration error:', err)
    res.status(400).json({ error: 'Failed to register customer. Phone or Email might already exist.' })
  }
})

// ============================================================
// MESSAGING API
// ============================================================

// Send a message
app.post('/api/messages', async (req, res) => {
  const { senderId, receiverId, text } = req.body
  if (!senderId || !receiverId || !text) {
    return res.status(400).json({ error: 'Missing message details' })
  }

  try {
    const message = await prisma.message.create({
      data: {
        text,
        senderId,
        receiverId
      }
    })
    res.json(message)
  } catch (error) {
    console.error('Send message error:', error)
    res.status(500).json({ error: 'Failed to send message' })
  }
})

// Get chat history between two users
app.get('/api/messages', async (req, res) => {
  const { userId1, userId2 } = req.query
  if (!userId1 || !userId2) {
    return res.status(400).json({ error: 'Missing user IDs' })
  }

  try {
    const messages = await prisma.message.findMany({
      where: {
        OR: [
          { senderId: userId1, receiverId: userId2 },
          { senderId: userId2, receiverId: userId1 }
        ]
      },
      orderBy: { createdAt: 'asc' }
    })

    // Mark received messages as read
    await prisma.message.updateMany({
      where: { senderId: userId2, receiverId: userId1, read: false },
      data: { read: true }
    })

    res.json(messages)
  } catch (error) {
    console.error('Get messages error:', error)
    res.status(500).json({ error: 'Failed to load messages' })
  }
})

// Get list of conversations for a user
app.get('/api/conversations', async (req, res) => {
  const { userId } = req.query
  if (!userId) return res.status(400).json({ error: 'Missing user ID' })

  try {
    // 1. Get the current user to determine role and linked users
    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        registeredBy: { select: { id: true, name: true, firstName: true, lastName: true, role: true } },
        registeredUsers: { select: { id: true, name: true, firstName: true, lastName: true, role: true } }
      }
    })

    if (!currentUser) return res.status(404).json({ error: 'User not found' })

    // 2. Get all existing message-based conversations
    const messages = await prisma.message.findMany({
      where: { OR: [{ senderId: userId }, { receiverId: userId }] },
      orderBy: { createdAt: 'desc' },
      include: {
        sender: { select: { id: true, name: true, firstName: true, lastName: true, role: true } },
        receiver: { select: { id: true, name: true, firstName: true, lastName: true, role: true } }
      }
    })

    const convosMap = new Map()
    messages.forEach(msg => {
      const otherUser = msg.senderId === userId ? msg.receiver : msg.sender
      if (!convosMap.has(otherUser.id)) {
        convosMap.set(otherUser.id, {
          id: otherUser.id,
          name: otherUser.name || `${otherUser.firstName || ''} ${otherUser.lastName || ''}`.trim() || 'No Name',
          lastMessage: msg.text,
          time: msg.createdAt,
          unreadCount: (msg.receiverId === userId && !msg.read) ? 1 : 0,
          role: otherUser.role
        })
      } else if (msg.receiverId === userId && !msg.read) {
        convosMap.get(otherUser.id).unreadCount++
      }
    })

    // 3. Add linked users who don't have messages yet
    // If client → add their registering worker
    if (currentUser.role === 'client' && currentUser.registeredBy) {
      const worker = currentUser.registeredBy
      if (!convosMap.has(worker.id)) {
        convosMap.set(worker.id, {
          id: worker.id,
          name: worker.name || `${worker.firstName || ''} ${worker.lastName || ''}`.trim() || 'Assigned Agent',
          lastMessage: 'Tap to start a conversation',
          time: currentUser.createdAt,
          unreadCount: 0,
          role: worker.role
        })
      }
    }

    // If worker → add all their registered clients
    if (currentUser.role === 'worker' && currentUser.registeredUsers) {
      currentUser.registeredUsers.forEach(client => {
        if (!convosMap.has(client.id)) {
          convosMap.set(client.id, {
            id: client.id,
            name: client.name || `${client.firstName || ''} ${client.lastName || ''}`.trim() || 'Client',
            lastMessage: 'Tap to start a conversation',
            time: currentUser.createdAt,
            unreadCount: 0,
            role: client.role
          })
        }
      })
    }

    res.json(Array.from(convosMap.values()))
  } catch (error) {
    console.error('Get conversations error:', error)
    res.status(500).json({ error: 'Failed to load conversations' })
  }
})

// Get assigned worker for a client
app.get('/api/users/worker', async (req, res) => {
  const { clientId } = req.query
  if (!clientId) return res.status(400).json({ error: 'Missing client ID' })

  try {
    const client = await prisma.user.findUnique({
      where: { id: clientId },
      include: { registeredBy: true }
    })
    res.json(client?.registeredBy || null)
  } catch (error) {
    res.status(500).json({ error: 'Failed to find worker' })
  }
})

// Get all houses (clients)
app.get('/api/worker/houses', async (req, res) => {
  try {
    const houses = await prisma.user.findMany({
      where: { role: 'client' },
      orderBy: { createdAt: 'desc' }
    })
    res.json(houses)
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch houses' })
  }
})

// Record a waste collection
app.post('/api/collections', async (req, res) => {
  const { clientId, workerId, notes } = req.body
  try {
    const collection = await prisma.collection.create({
      data: {
        clientId,
        workerId,
        notes
      }
    })
    res.json(collection)
  } catch (err) {
    res.status(400).json({ error: 'Failed to record collection' })
  }
})

// ============================================================
// BILLING & PAYMENTS
// ============================================================

// Get real weeks for a client based on registration date
app.get('/api/client/billing', async (req, res) => {
  const { userId } = req.query
  if (!userId) return res.status(400).json({ error: 'Missing user ID' })

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user) return res.status(404).json({ error: 'User not found' })

    const payments = await prisma.payment.findMany({
      where: { userId, status: 'completed' }
    })

    const startDate = new Date(user.createdAt)
    const today = new Date()
    const diffTime = Math.abs(today - startDate)
    const totalWeeksSinceReg = Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24 * 7)))

    const weeks = []
    for (let i = 0; i < totalWeeksSinceReg + 2; i++) { // Show actual weeks + 2 upcoming
      const weekDate = new Date(startDate)
      weekDate.setDate(weekDate.getDate() + (i * 7))
      
      const isPast = weekDate < today
      const weekLabel = `Week ${i + 1} (${weekDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`
      
      // Determine if paid by looking at payment count or specific records
      // Simple logic: if payment records exist for this user, mark the earliest weeks as paid
      const isPaid = i < payments.length

      weeks.push({
        id: i + 1,
        label: weekLabel,
        amount: user.category === 'rich' ? 5000 : 2000,
        status: isPaid ? 'paid' : (isPast ? 'overdue' : 'upcoming'),
        dueDate: weekDate.toISOString()
      })
    }

    res.json(weeks)
  } catch (error) {
    console.error('Billing error:', error)
    res.status(500).json({ error: 'Failed to load billing data' })
  }
})

// Process a payment
app.post('/api/payments', async (req, res) => {
  const { userId, amount, method, service } = req.body
  try {
    const payment = await prisma.payment.create({
      data: {
        userId,
        amount: parseFloat(amount),
        method,
        service: service || 'Waste Collection',
        status: 'completed',
        transactionId: 'TXN-' + Math.random().toString(36).substr(2, 9).toUpperCase()
      }
    })
    res.json(payment)
  } catch (err) {
    console.error('Payment error:', err)
    res.status(400).json({ error: 'Failed to process payment' })
  }
})

// ANALYTICS & STATS API (For Dashboards)
// ============================================================

// GET /api/worker/stats?workerId=...
app.get('/api/worker/stats', async (req, res) => {
  const { workerId } = req.query
  if (!workerId) return res.status(400).json({ error: 'Missing worker ID' })

  try {
    const totalCustomers = await prisma.user.count({
      where: { registeredById: workerId, role: 'client' }
    })

    // Sub-select to find clients of this worker
    const clientIds = (await prisma.user.findMany({
      where: { registeredById: workerId, role: 'client' },
      select: { id: true }
    })).map(u => u.id)

    const oneWeekAgo = new Date()
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7)

    // Payments from clients of this worker in the last 7 days
    const recentPaymentsRaw = await prisma.payment.findMany({
      where: {
        userId: { in: clientIds },
        date: { gte: oneWeekAgo }
      },
      include: { user: true },
      orderBy: { date: 'desc' }
    })

    const paidCount = new Set(recentPaymentsRaw.map(p => p.userId)).size

    res.json({
      totalCustomers,
      paidThisWeek: paidCount,
      unpaidThisWeek: totalCustomers - paidCount,
      bannedHouses: 0, // Logic for banning can be added later
      warningCount: 0,
      recentPayments: recentPaymentsRaw.slice(0, 5).map(p => ({
        id: p.id,
        name: p.user?.name || 'Customer',
        village: p.user?.village || 'Unknown',
        amount: p.amount,
        time: p.date
      }))
    })
  } catch (error) {
    console.error('Worker stats error:', error)
    res.status(500).json({ error: 'Failed to aggregate statistics' })
  }
})

// GET /api/client/stats?clientId=...
app.get('/api/client/stats', async (req, res) => {
  const { clientId } = req.query
  if (!clientId) return res.status(400).json({ error: 'Missing client ID' })

  try {
    const payments = await prisma.payment.findMany({
      where: { userId: clientId }
    })

    const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0)
    
    // Find assigned worker
    const client = await prisma.user.findUnique({
      where: { id: clientId },
      include: { registeredBy: true }
    })

    res.json({
      totalPaid,
      paymentRate: totalPaid > 0 ? 100 : 0, // Simplified logic
      rating: 5.0,
      worker: client?.registeredBy ? {
        name: client.registeredBy.name,
        phone: client.registeredBy.phone
      } : null
    })
  } catch (error) {
    console.error('Client stats error:', error)
    res.status(500).json({ error: 'Failed to aggregate statistics' })
  }
})

// ============================================================
// SYSTEM PULSE & GLOBAL SYNC
// ============================================================

app.get('/api/system/pulse', async (req, res) => {
  const { userId, role } = req.query
  if (!userId || !role) return res.status(400).json({ error: 'Missing userId or role' })

  try {
    const responseData = {
      unreadMessagesCount: 0,
      stats: {},
      badges: {}
    }

    // 1. Unread Messages (Global for all)
    responseData.unreadMessagesCount = await prisma.message.count({
      where: { receiverId: userId, read: false }
    })

    // 2. Role-specific stats & User data
    if (role === 'worker') {
      const totalCustomers = await prisma.user.count({
        where: { registeredById: userId, role: 'client' }
      })

      const clientIds = (await prisma.user.findMany({
        where: { registeredById: userId, role: 'client' },
        select: { id: true }
      })).map(u => u.id)

      const oneWeekAgo = new Date()
      oneWeekAgo.setDate(oneWeekAgo.getDate() - 7)

      const recentPaymentsRaw = await prisma.payment.findMany({
        where: { userId: { in: clientIds }, date: { gte: oneWeekAgo } },
        include: { user: true },
        orderBy: { date: 'desc' }
      })

      const paidCount = new Set(recentPaymentsRaw.map(p => p.userId)).size

      responseData.stats = {
        totalCustomers,
        paidThisWeek: paidCount,
        unpaidThisWeek: totalCustomers - paidCount,
        recentPayments: recentPaymentsRaw.slice(0, 5).map(p => ({
          id: p.id,
          name: p.user?.name || 'Customer',
          amount: p.amount,
          time: p.date
        }))
      }
    } else if (role === 'client') {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: { registeredBy: true }
      })

      if (user) {
        const payments = await prisma.payment.findMany({
          where: { userId, status: 'completed' }
        })

        // Billing Engine Logic
        const startDate = new Date(user.createdAt)
        const today = new Date()
        const diffWeeks = Math.max(0, Math.floor((today - startDate) / (1000 * 60 * 60 * 24 * 7)))
        const weeksPaid = payments.length // Simple assumption: 1 payment = 1 week
        const weeksOwed = Math.max(0, diffWeeks - weeksPaid)
        const weekRate = user.category === 'rich' ? 5000 : 2000
        const totalDebt = weeksOwed * weekRate

        responseData.stats = {
          totalPaid: payments.reduce((sum, p) => sum + p.amount, 0),
          totalDebt,
          weeksOwed,
          paymentRate: diffWeeks > 0 ? Math.round((weeksPaid / diffWeeks) * 100) : 100
        }

        responseData.user = {
          id: user.id,
          name: user.name,
          village: user.village,
          category: user.category,
          assignedWorker: user.registeredBy ? {
            name: user.registeredBy.name,
            phone: user.registeredBy.phone
          } : null
        }

        // Add badges for debt alert
        responseData.badges = {
          debts: weeksOwed
        }
      }
    }

    // 6. Real-time Announcements from DB
    const announcements = await prisma.announcement.findMany({
      orderBy: { date: 'desc' },
      take: 5
    })
    
    responseData.systemUpdates = announcements.map(a => ({
      id: a.id,
      title: a.title,
      content: a.content,
      date: a.date.toISOString(),
      type: a.type,
      author: a.author
    }))

    res.json(responseData)
  } catch (err) {
    console.error('Pulse error:', err)
    res.status(500).json({ error: 'Pulse failed' })
  }
})

app.listen(PORT, () => {
  console.log(`[API] Server running on http://localhost:${PORT}`)
})
