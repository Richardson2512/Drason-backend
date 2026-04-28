/**
 * Compares Prisma schema model field names against actual DB columns and
 * prints all columns the schema expects but the DB is missing. Does NOT
 * modify anything — read-only diagnostic.
 */
import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';

const p = new PrismaClient();

interface FieldDef { name: string; type: string; optional: boolean; }

function parseSchema(): Map<string, FieldDef[]> {
    const text = fs.readFileSync(
        path.join(__dirname, '..', 'prisma', 'schema.prisma'),
        'utf8',
    );
    const models = new Map<string, FieldDef[]>();
    const modelRe = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
    let m: RegExpExecArray | null;
    while ((m = modelRe.exec(text))) {
        const name = m[1];
        const body = m[2];
        const fields: FieldDef[] = [];
        for (const rawLine of body.split('\n')) {
            const line = rawLine.trim();
            if (!line || line.startsWith('//') || line.startsWith('@@')) continue;
            const parts = line.split(/\s+/);
            if (parts.length < 2) continue;
            const fname = parts[0];
            let ftype = parts[1];
            if (!/^[a-zA-Z_]/.test(fname)) continue;
            // Skip relation fields (uppercase first letter typically) — we
            // only care about scalar columns. Heuristic: skip if type starts
            // with uppercase AND has no relation marker (not perfect).
            const isRelation = /^[A-Z]/.test(ftype) && !['String', 'Int', 'BigInt', 'Float', 'Decimal', 'Boolean', 'DateTime', 'Json', 'Bytes'].includes(ftype.replace(/[?\[\]]/g, ''));
            if (isRelation) continue;
            const optional = ftype.endsWith('?') || ftype.endsWith('[]');
            ftype = ftype.replace(/[?\[\]]/g, '');
            fields.push({ name: fname, type: ftype, optional });
        }
        models.set(name, fields);
    }
    return models;
}

const PRISMA_TO_PG: Record<string, string> = {
    String: 'TEXT',
    Int: 'INTEGER',
    BigInt: 'BIGINT',
    Float: 'DOUBLE PRECISION',
    Decimal: 'DECIMAL(65,30)',
    Boolean: 'BOOLEAN',
    DateTime: 'TIMESTAMP',
    Json: 'JSONB',
    Bytes: 'BYTEA',
};

async function main() {
    const models = parseSchema();
    const missing: { table: string; column: string; type: string; optional: boolean }[] = [];

    for (const [model, fields] of models.entries()) {
        const dbCols = await p
            .$queryRawUnsafe<{ column_name: string }[]>(
                `SELECT column_name FROM information_schema.columns WHERE table_name=$1`,
                model,
            )
            .catch(() => [] as { column_name: string }[]);
        if (dbCols.length === 0) continue; // table doesn't exist; skip
        const dbColSet = new Set(dbCols.map((c) => c.column_name));

        for (const f of fields) {
            if (!dbColSet.has(f.name)) {
                const pgType = PRISMA_TO_PG[f.type];
                if (!pgType) continue; // enum or unknown — skip
                missing.push({ table: model, column: f.name, type: pgType, optional: f.optional });
            }
        }
    }

    console.log(JSON.stringify(missing, null, 2));
    console.log(`\nTotal missing columns: ${missing.length}`);
    await p.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
