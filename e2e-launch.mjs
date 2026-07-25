// LOCAL E2E launcher — boots the real server with an in-memory store and seeds
// a QA admin + QA user directly (bypassing the signup human-check). Never used
// in production. Prints the two user ids as JSON on the last line.
process.env.PORT = process.env.PORT || '3210';
process.env.ADMIN_EMAILS = 'admin@3jntravel.com';
process.env.LIVE_MODE = 'false';
process.env.NODE_ENV = 'development';
const { createUser, creditAcu } = await import('./backend/src/store.js');
const { default: app } = await import('./backend/src/server.js');
const admin = createUser({ name: 'QA Admin', email: 'admin@3jntravel.com', role: 'admin', allAccess: true, emailVerified: true });
const user = createUser({ name: 'QA User', email: 'qa.user@test.co' });
try { creditAcu(user.id, 500, 'e2e-seed'); } catch {}
app.listen(Number(process.env.PORT), () => {
  console.log('E2E_IDS ' + JSON.stringify({ adminId: admin.id, userId: user.id }));
  console.log('E2E_LISTENING ' + process.env.PORT);
});
