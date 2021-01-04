module.exports = {
  apps : [{
    name: 'validators',
    cwd: 'dist',
    script: 'main.js',
    restart_delay: 1000,
    watch: 'main.js',
    out_file: 'validator-health.log',
    error_file: 'validator-health-error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss:SSS',
  }]
};

