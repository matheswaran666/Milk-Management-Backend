const catalyst = require('zcatalyst-sdk-node');

/**
 * Catalyst Database Wrapper
 * Maps ZCQL (Zoho Catalyst Query Language) responses to the format expected by the app.
 */

let catalystApp = null;

const getCatalystApp = () => {
  if (catalystApp) return catalystApp;

  // Initialize with initializeApp (v3 standard for standalone apps)
  catalystApp = catalyst.initializeApp({
    project_id:  process.env.CATALYST_PROJECT_ID,
    project_key: process.env.CATALYST_PROJECT_KEY,
    environment: process.env.CATALYST_ENVIRONMENT || 'Development',
    credential: catalyst.credential.refreshToken({
      client_id:     process.env.CATALYST_CLIENT_ID,
      client_secret: process.env.CATALYST_CLIENT_SECRET,
      refresh_token: process.env.CATALYST_REFRESH_TOKEN
    })
  }, process.env.CATALYST_REGION || 'IN');

  return catalystApp;
};

/**
 * Execute a ZCQL query and flatten the response
 * ZCQL returns: [{ table_name: { col1: val1, ... } }]
 * MySQL returns: [{ col1: val1, ... }]
 */
const executeZCQL = async (sql, params = []) => {
  try {
    const app = getCatalystApp();
    const zcql = app.zcql();

    let finalSql = sql;
    if (params && params.length > 0) {
      // Basic placeholder replacement (Note: This is a simplified version for common SQL types)
      params.forEach(p => {
        const val = typeof p === 'string' ? `'${p.replace(/'/g, "''")}'` : p;
        finalSql = finalSql.replace('?', val);
      });
    }

    const result = await zcql.executeZCQLQuery(finalSql);

    // Flatten the result
    // [{ table1: { id: 1 }, table2: { name: 'x' } }] -> [{ id: 1, name: 'x' }]
    const flattened = result.map(row => {
      let flatRow = {};
      Object.keys(row).forEach(table => {
        // Map ROWID to id for compatibility
        if (row[table].ROWID && !row[table].id) {
            row[table].id = row[table].ROWID;
        }
        flatRow = { ...flatRow, ...row[table] };
      });
      return flatRow;
    });

    return [flattened];
  } catch (err) {
    console.error('ZCQL Execution Error:', err.message);
    throw err;
  }
};

const catalystPool = {
  execute: executeZCQL,
  query:   executeZCQL,
  getConnection: async () => ({
    execute: executeZCQL,
    query:   executeZCQL,
    release: () => {}
  })
};

const testCatalystConnection = async () => {
  try {
    // A simple query to test connectivity
    await executeZCQL('SELECT ROWID FROM providers LIMIT 1');
    console.log('✅ Zoho Catalyst connected successfully');
  } catch (err) {
    console.error('❌ Zoho Catalyst connection failed:', err.message || err);
    if (err.stack) console.debug(err.stack);
  }
};

module.exports = { catalystPool, testCatalystConnection };
