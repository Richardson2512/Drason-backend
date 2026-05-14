SELECT migration_name,
       finished_at IS NOT NULL AS finished,
       rolled_back_at IS NOT NULL AS rolled_back,
       LEFT(COALESCE(logs, ''), 60) AS logs_preview,
       started_at
FROM _prisma_migrations
WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL
ORDER BY started_at DESC;
