/**
 * pm2 process manifest. Run with `npx pm2 start ecosystem.config.cjs`.
 *
 * Why pm2 instead of bare `tsx watch &`:
 *   - Auto-restart on crash, OOM, or signal
 *   - Survives terminal closes (process is reparented to launchd-owned daemon)
 *   - Aggregated, persistent logs at ~/.pm2/logs/
 *   - Memory cap (1G) so a runaway worker can't take down the laptop
 *
 * Common commands:
 *   npx pm2 status                    # see whether the backend is up
 *   npx pm2 logs superkabe-backend    # tail combined stdout+stderr
 *   npx pm2 restart superkabe-backend # manual restart
 *   npx pm2 stop superkabe-backend    # stop without removing
 *   npx pm2 delete superkabe-backend  # remove from pm2
 *   npx pm2 save                      # persist current process list
 */
module.exports = {
    apps: [
        {
            name: 'superkabe-backend',
            script: 'src/index.ts',
            interpreter: require('path').join(__dirname, 'node_modules', '.bin', 'tsx'),
            interpreter_args: 'watch',
            cwd: __dirname,
            // tsx watch handles file change reloading itself; tell pm2 not to
            // also watch — would cause double-restarts.
            watch: false,
            autorestart: true,
            max_restarts: 20,
            min_uptime: '10s',
            max_memory_restart: '1G',
            env: {
                NODE_ENV: 'development',
            },
            // Log files live under ~/.pm2/logs/
            merge_logs: true,
            time: true,
        },
    ],
};
