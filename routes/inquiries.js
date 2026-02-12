const express = require('express');
const B2BInquiry = require('../../server/models/B2BInquiry');
const { sendB2BInquiryNotification } = require('../../server/utils/email');
const { sanitizeBody } = require('../../server/middleware/sanitize');
const logger = require('../../server/utils/logger');
const router = express.Router();

// POST /api/corporate/inquiries - public inquiry (no auth required)
router.post('/', sanitizeBody, async (req, res) => {
  try {
    const { companyName, contactPerson, email, phone, numberOfEmployees, budgetPerGift, quantityNeeded, occasion, specialRequirements } = req.body;

    if (!companyName || !contactPerson || !email || !phone) {
      return res.status(400).json({ message: 'Company name, contact person, email, and phone are required' });
    }

    const inquiry = new B2BInquiry({
      companyName,
      contactPerson,
      email,
      phone,
      numberOfEmployees,
      budgetPerGift,
      quantityNeeded,
      occasion,
      specialRequirements,
      activityLog: [{ action: 'Inquiry submitted via corporate portal', timestamp: new Date() }]
    });

    await inquiry.save();

    try { await sendB2BInquiryNotification(inquiry); } catch (e) { logger.error('B2B notification failed:', e.message); }

    res.status(201).json({ message: 'Thank you! We\'ll get back to you within 24 hours.', inquiry: { _id: inquiry._id } });
  } catch (err) {
    res.status(500).json({ message: 'Failed to submit inquiry' });
  }
});

module.exports = router;
