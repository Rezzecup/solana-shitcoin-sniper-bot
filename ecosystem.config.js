module.exports = {
  apps: [{
    name: 'solana_sniper',              // Application name
    script: 'client/dist/index.js',          // Main script path
    instances: '1',            // Number of instances to start (can be 'max' to use all CPUs)
    autorestart: false,           // Auto-restart if the app crashes
    watch: false,                // Watch mode: restarts the app on file changes
    max_memory_restart: '8G',    // Restart the app if it reaches 1GB memory usage
    env: {
      NODE_ENV: 'development',  // Environment variables for development
    },
    env_production: {
      NODE_ENV: 'production',   // Environment variables for production
    }
  }]
};
