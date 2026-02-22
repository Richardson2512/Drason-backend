import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function check() {
  const events = await prisma.rawEvent.findMany({
    orderBy: { created_at: 'desc' },
    take: 1
  });
  console.log('Most recent event:', JSON.stringify(events, null, 2));
}
check().catch(console.error).finally(() => prisma.$disconnect());
