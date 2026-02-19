module.exports = {
  apps: [{
    name: 'digit-mcp',
    script: 'dist/index.js',
    cwd: '/root/crs-validator-mcp',
    env: {
      MCP_TRANSPORT: 'http',
      MCP_PORT: '3100',
      CRS_ENVIRONMENT: 'chakshu-digit',
      CRS_USERNAME: 'ADMIN',
      CRS_PASSWORD: 'eGov@123',
      CRS_TENANT_ID: 'pg',
    },
  }],
};
