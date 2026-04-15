const { PrismaClient } = require('@prisma/client')
const { Pool } = require('pg')
const { PrismaPg } = require('@prisma/adapter-pg')
const dotenv = require('dotenv')
dotenv.config()
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

async function main() {
  await prisma.announcement.deleteMany()
  await prisma.announcement.createMany({
    data: [
      {
        title: 'Umuganda Update',
        content: 'Monthly community work has been rescheduled to next Sunday.',
        type: 'feature',
        author: 'Emmanuel K.',
        date: new Date(Date.now() - 3600000)
      },
      {
        title: 'New Payment Method',
        content: 'Clients can now use Airtel Money to pay their monthly dues.',
        type: 'success',
        author: 'Jean-Paul N.',
        date: new Date(Date.now() - 7200000)
      },
      {
        title: 'System Maintenance',
        content: 'The dashboard will be under short maintenance tonight.',
        type: 'alert',
        author: 'Admin Team',
        date: new Date(Date.now() - 86400000)
      },
      {
        title: 'Congratulations',
        content: 'Kacyiru sector recorded 100% fast compliance this week.',
        type: 'info',
        author: 'Marie C.',
        date: new Date(Date.now() - 259200000)
      }
    ]
  })
  console.log("Announcements seeded")
}
main().finally(() => prisma.$disconnect())
