module.exports = {
  apps : [{
    name: 'validators',
    cwd: 'dist',
    script: 'main.js',
    restart_delay: 1000,
    watch: 'main.js',
    log_file: 'validator-health.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss:SSS',
  }]
};

