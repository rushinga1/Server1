const { PrismaClient } = require('@prisma/client')
const { Pool } = require('pg')
const { PrismaPg } = require('@prisma/adapter-pg')
const dotenv = require('dotenv')

dotenv.config()

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

async function main() {
  const users = await prisma.user.findMany({
    include: {
      registeredBy: true,
      registeredUsers: true
    }
  })
  console.dir(users.map(u => ({ id: u.id, email: u.email, role: u.role, registeredById: u.registeredById, registeredBy: u.registeredBy?.id, registeredUsers: u.registeredUsers.map(ru => ru.id) })), { depth: null })
}

main().finally(() => prisma.$disconnect())
