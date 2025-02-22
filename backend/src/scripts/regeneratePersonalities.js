const pool = require('../services/db');
const commentingService = require('../services/commentingService');

async function regeneratePersonalities() {
  const client = await pool.connect();
  try {
    // Get all social accounts
    const result = await client.query('SELECT * FROM social_accounts WHERE status = \'active\'');
    console.log(`Found ${result.rows.length} active accounts to update`);

    // Update each account with new persona traits
    for (const account of result.rows) {
      const persona = await commentingService.generatePersonalityTraits();
      await client.query(
        'UPDATE social_accounts SET persona_traits = $1 WHERE id = $2',
        [JSON.stringify(persona), account.id]
      );
      console.log(`Updated persona for account ${account.id} (${account.username}):`, persona);
    }

    console.log('Successfully regenerated all persona traits');
  } catch (error) {
    console.error('Error regenerating personas:', error);
  } finally {
    client.release();
  }
}

// Run if called directly
if (require.main === module) {
  regeneratePersonalities().then(() => {
    console.log('Finished regenerating personas');
    process.exit(0);
  }).catch(error => {
    console.error('Failed to regenerate personas:', error);
    process.exit(1);
  });
}

module.exports = regeneratePersonalities; 