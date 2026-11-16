'use strict';
async function migrateSsoAccountStatus(pool) {
    const [columns] = await pool.execute(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sso_role_authority' AND COLUMN_NAME='account_status'`);
    if (!columns.length) await pool.execute('ALTER TABLE sso_role_authority ADD COLUMN account_status VARCHAR(16) NULL');
}
module.exports = { migrateSsoAccountStatus };
