const { PrismaClient } = require('@prisma/client')
const { Pool } = require('pg')
const { PrismaPg } = require('@prisma/adapter-pg')
const dotenv = require('dotenv')
dotenv.config()

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

async function main() {
  await prisma.user.update({
    where: { email: 'cyusaclever@gmail.com' },
    data: { role: 'worker', firstName: 'Cyusa', lastName: 'Clever' }
  })
  
  const worker = await prisma.user.findUnique({ where: { email: 'cyusaclever@gmail.com' } })
  
  await prisma.user.update({
    where: { email: 'rushingacedrick@gmail.com' },
    data: { registeredById: worker.id, firstName: 'Rushinga', lastName: 'Cedrick' }
  })

  await prisma.user.update({
    where: { email: 'irumvaclarene400@gmail.com' },
    data: { registeredById: worker.id, firstName: 'Irumva', lastName: 'Clarene' }
  })
  
  console.log("Database linked successfully.")
}

main().catch(e => console.error(e)).finally(() => prisma.$disconnect())
