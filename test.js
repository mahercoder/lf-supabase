
const OTP_EXPIRATION_TIME = 600;
const expiresAt = new Date(Date.now() + OTP_EXPIRATION_TIME).toISOString();

console.log(expiresAt); 