const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const CorporateUser = require('../../server/models/CorporateUser');
const { sendOTP } = require('../../server/utils/email');
const { requireCorporateAuth, isCorporateEmail } = require('../middleware/corporateAuth');
const router = express.Router();

const generateOTP = () => crypto.randomInt(100000, 999999).toString();

// Rate limiter: max 5 OTP requests per email per 15 minutes
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.body?.email?.toLowerCase?.()?.trim() || req.ip,
  message: { message: 'Too many OTP requests. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Rate limiter: max 10 OTP verifications per IP per 15 minutes
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { message: 'Too many verification attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

// POST /api/corporate/auth/send-otp
router.post('/send-otp', otpLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email is required' });

    const normalizedEmail = email.toLowerCase().trim();

    // Validate corporate email
    if (!isCorporateEmail(normalizedEmail)) {
      return res.status(400).json({ message: 'Please use your corporate email address. Personal emails (Gmail, Yahoo, Outlook, etc.) are not accepted.' });
    }

    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + (parseInt(process.env.OTP_EXPIRY_MINUTES || '10')) * 60 * 1000);

    let user = await CorporateUser.findOne({ email: normalizedEmail });
    if (!user) {
      // Will be fully created on verify-otp with company details
      user = new CorporateUser({
        email: normalizedEmail,
        companyName: normalizedEmail.split('@')[1].split('.')[0], // temp company name from domain
        contactPerson: ''
      });
    }

    user.otp = otp;
    user.otpExpiry = otpExpiry;
    await user.save();

    await sendOTP(normalizedEmail, otp);

    res.json({ message: 'OTP sent to your corporate email', isNewUser: !user.contactPerson });
  } catch (err) {
    console.error('Corporate send OTP error:', err);
    res.status(500).json({ message: 'Failed to send OTP' });
  }
});

// POST /api/corporate/auth/verify-otp
router.post('/verify-otp', verifyLimiter, async (req, res) => {
  try {
    const { email, otp, companyName, contactPerson, phone, designation, companySize } = req.body;
    if (!email || !otp) return res.status(400).json({ message: 'Email and OTP required' });

    const normalizedEmail = email.toLowerCase().trim();
    const otpStr = String(otp).trim();

    // Atomic OTP verification
    const user = await CorporateUser.findOneAndUpdate(
      {
        email: normalizedEmail,
        otp: otpStr,
        otpExpiry: { $gt: new Date() }
      },
      { $set: { otp: null, otpExpiry: null } },
      { new: true }
    );

    if (!user) {
      const existing = await CorporateUser.findOne({ email: normalizedEmail });
      if (!existing) return res.status(400).json({ message: 'No account found. Please request OTP first.' });
      if (!existing.otp || !existing.otpExpiry) return res.status(400).json({ message: 'OTP expired or not requested. Please resend.' });
      if (new Date() > existing.otpExpiry) return res.status(400).json({ message: 'OTP expired. Request a new one.' });
      return res.status(400).json({ message: 'Invalid OTP' });
    }

    if (user.status === 'suspended') {
      return res.status(403).json({ message: 'Corporate account suspended. Contact support.' });
    }

    // Update profile if new user or if details provided
    if (companyName) user.companyName = companyName;
    if (contactPerson) user.contactPerson = contactPerson;
    if (phone) user.phone = phone;
    if (designation) user.designation = designation;
    if (companySize) user.companySize = companySize;
    await user.save();

    const token = jwt.sign({ corporateUserId: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });

    res.json({
      token,
      user: {
        _id: user._id,
        email: user.email,
        companyName: user.companyName,
        contactPerson: user.contactPerson,
        phone: user.phone,
        designation: user.designation,
        companySize: user.companySize,
        status: user.status,
        gstNumber: user.gstNumber
      }
    });
  } catch (err) {
    console.error('Corporate verify OTP error:', err);
    res.status(500).json({ message: 'Verification failed' });
  }
});

// GET /api/corporate/auth/me
router.get('/me', requireCorporateAuth, async (req, res) => {
  const u = req.corporateUser;
  res.json({
    user: {
      _id: u._id,
      email: u.email,
      companyName: u.companyName,
      contactPerson: u.contactPerson,
      phone: u.phone,
      designation: u.designation,
      companySize: u.companySize,
      gstNumber: u.gstNumber,
      status: u.status,
      billingAddress: u.billingAddress,
      shippingAddresses: u.shippingAddresses
    }
  });
});

// PUT /api/corporate/auth/profile
router.put('/profile', requireCorporateAuth, async (req, res) => {
  try {
    const u = req.corporateUser;
    const { companyName, contactPerson, phone, designation, companySize, gstNumber, billingAddress, shippingAddresses } = req.body;

    if (companyName) u.companyName = companyName;
    if (contactPerson) u.contactPerson = contactPerson;
    if (phone) u.phone = phone;
    if (designation !== undefined) u.designation = designation;
    if (companySize) u.companySize = companySize;
    if (gstNumber !== undefined) u.gstNumber = gstNumber;
    if (billingAddress) u.billingAddress = billingAddress;
    if (shippingAddresses) u.shippingAddresses = shippingAddresses;

    await u.save();
    res.json({ message: 'Profile updated', user: u });
  } catch (err) {
    res.status(500).json({ message: 'Update failed' });
  }
});

module.exports = router;
