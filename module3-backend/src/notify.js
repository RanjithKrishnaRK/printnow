// src/notify.js
//
// STUB for v1. Real SMS/WhatsApp integration (Twilio, Gupshup, WhatsApp
// Business API...) plugs in here later - this is the ONLY function that
// would need to change. Everything else in the codebase just calls
// notifyStudent() and doesn't know or care how the message is actually sent.

function notifyStudent(studentPhone, message) {
  // TODO: replace with real SMS/WhatsApp API call, e.g.:
  //   await twilioClient.messages.create({ to: studentPhone, body: message, from: TWILIO_FROM })
  console.log(`[NOTIFY STUB] -> ${studentPhone}: ${message}`);
}

module.exports = { notifyStudent };
