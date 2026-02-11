const jwt = require('jsonwebtoken');
const CorporateUser = require('../../server/models/CorporateUser');

// Free/personal email domains that are NOT corporate
const FREE_EMAIL_DOMAINS = [
  'gmail.com', 'yahoo.com', 'yahoo.in', 'yahoo.co.in',
  'outlook.com', 'hotmail.com', 'live.com',
  'aol.com', 'icloud.com', 'me.com', 'mac.com',
  'protonmail.com', 'proton.me',
  'mail.com', 'email.com',
  'yandex.com', 'yandex.ru',
  'zoho.com', 'rediffmail.com',
  'fastmail.com', 'tutanota.com',
  'gmx.com', 'gmx.net',
  'inbox.com', 'mail.ru'
];

/**
 * Check if an email is a corporate email (not a free provider).
 */
function isCorporateEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const domain = email.toLowerCase().trim().split('@')[1];
  if (!domain) return false;
  return !FREE_EMAIL_DOMAINS.includes(domain);
}

/**
 * Verify JWT and load CorporateUser. Attaches req.corporateUser.
 */
const requireCorporateAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await CorporateUser.findById(decoded.corporateUserId).select('-otp -otpExpiry');
    if (!user) return res.status(401).json({ message: 'Corporate account not found' });

    if (user.status === 'suspended') {
      return res.status(403).json({ message: 'Corporate account suspended. Contact support.' });
    }

    req.corporateUser = user;
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
};

/**
 * Require active status (not pending_approval).
 */
const requireActiveStatus = async (req, res, next) => {
  if (!req.corporateUser) return res.status(401).json({ message: 'Authentication required' });
  if (req.corporateUser.status !== 'active') {
    return res.status(403).json({ message: 'Your corporate account is pending approval. An admin will review and activate it shortly.' });
  }
  next();
};

module.exports = { requireCorporateAuth, requireActiveStatus, isCorporateEmail, FREE_EMAIL_DOMAINS };
