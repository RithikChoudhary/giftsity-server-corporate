const express = require('express');
const CorporateQuote = require('../../server/models/CorporateQuote');
const Order = require('../../server/models/Order');
const Product = require('../../server/models/Product');
const { createCashfreeOrder } = require('../../server/config/cashfree');
const { requireCorporateAuth, requireActiveStatus } = require('../middleware/corporateAuth');
const { logActivity } = require('../../server/utils/audit');
const { generateQuoteDocument } = require('../../server/utils/pdf');
const logger = require('../../server/utils/logger');
const router = express.Router();

// Normalize phone to 10 digits for Cashfree
const normalizePhone = (phone) => {
  const digits = (phone || '').replace(/\D/g, '');
  if (digits.length >= 10) return digits.slice(-10);
  return '9999999999';
};

router.use(requireCorporateAuth, requireActiveStatus);

// GET /api/corporate/quotes - list quotes for this corporate user
router.get('/', async (req, res) => {
  try {
    const quotes = await CorporateQuote.find({
      $or: [
        { corporateUserId: req.corporateUser._id },
        { contactEmail: req.corporateUser.email }
      ],
      status: { $in: ['sent', 'approved', 'rejected', 'expired', 'converted'] }
    }).sort({ createdAt: -1 });

    res.json({ quotes });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/corporate/quotes/:id
router.get('/:id', async (req, res) => {
  try {
    const quote = await CorporateQuote.findOne({
      _id: req.params.id,
      $or: [
        { corporateUserId: req.corporateUser._id },
        { contactEmail: req.corporateUser.email }
      ]
    }).populate('items.productId', 'images title slug');

    if (!quote) return res.status(404).json({ message: 'Quote not found' });
    res.json({ quote });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/corporate/quotes/:id/pdf - download quote as PDF
router.get('/:id/pdf', async (req, res) => {
  try {
    const quote = await CorporateQuote.findOne({
      _id: req.params.id,
      $or: [
        { corporateUserId: req.corporateUser._id },
        { contactEmail: req.corporateUser.email }
      ]
    }).populate('items.productId', 'images title').lean();

    if (!quote) return res.status(404).json({ message: 'Quote not found' });

    const pdfBuffer = await generateQuoteDocument(quote);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="quote-${quote.quoteNumber}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    logger.error('Quote PDF error:', err.message);
    res.status(500).json({ message: 'Failed to generate quote PDF' });
  }
});

// POST /api/corporate/quotes/:id/approve - approve quote, create order + payment session
router.post('/:id/approve', async (req, res) => {
  try {
    const { shippingAddress } = req.body;
    const quote = await CorporateQuote.findOne({
      _id: req.params.id,
      $or: [{ corporateUserId: req.corporateUser._id }, { contactEmail: req.corporateUser.email }],
      status: 'sent'
    });

    if (!quote) return res.status(404).json({ message: 'Quote not found or not in "sent" status' });

    // Check expiry
    if (quote.validUntil && new Date() > quote.validUntil) {
      quote.status = 'expired';
      await quote.save();
      return res.status(400).json({ message: 'This quote has expired. Please request a new one.' });
    }

    const address = shippingAddress || req.corporateUser.shippingAddresses?.find(a => a.isDefault) || req.corporateUser.shippingAddresses?.[0];
    if (!address) return res.status(400).json({ message: 'Shipping address required' });

    // Create order from quote
    const d = new Date();
    const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const rand = String(Math.floor(Math.random() * 9999)).padStart(4, '0');
    const orderNumber = `GFT-B2B-${date}-${rand}`;

    const order = new Order({
      orderNumber,
      orderType: 'b2b_direct',
      customerId: null,
      customerEmail: req.corporateUser.email,
      customerPhone: req.corporateUser.phone || address.phone,
      items: quote.items.map(i => ({
        productId: i.productId,
        title: i.title,
        price: i.unitPrice,
        image: i.image,
        quantity: i.quantity,
        sellerId: null // Will be set from product if needed
      })),
      shippingAddress: address,
      itemTotal: quote.totalAmount,
      shippingCost: 0,
      totalAmount: quote.finalAmount,
      commissionRate: 0,
      commissionAmount: 0,
      paymentGatewayFee: 0,
      sellerAmount: quote.finalAmount,
      notes: `Created from quote ${quote.quoteNumber} for ${quote.companyName}`
    });
    await order.save();

    // Create Cashfree payment
    const cfOrder = await createCashfreeOrder({
      orderId: orderNumber,
      orderAmount: quote.finalAmount,
      customerDetails: {
        customerId: req.corporateUser._id.toString(),
        email: req.corporateUser.email,
        phone: normalizePhone(req.corporateUser.phone || address.phone),
        name: req.corporateUser.companyName
      },
      returnUrl: `${(process.env.CLIENT_URL || '').split(',')[0].trim() || 'http://localhost:5173'}/corporate/orders?cf_id=${orderNumber}`
    });

    order.cashfreeOrderId = orderNumber;
    order.paymentSessionId = cfOrder.payment_session_id;
    await order.save();

    // Update quote status
    quote.status = 'approved';
    quote.convertedOrderId = order._id;
    await quote.save();

    logActivity({ domain: 'corporate', action: 'quote_approved', actorRole: 'corporate', actorId: req.corporateUser._id, actorEmail: req.corporateUser.email, targetType: 'CorporateQuote', targetId: quote._id, message: `Quote ${quote.quoteNumber} approved by ${req.corporateUser.companyName}`, metadata: { quoteNumber: quote.quoteNumber, finalAmount: quote.finalAmount, orderId: order._id.toString() } });

    res.json({
      message: 'Quote approved! Proceed to payment.',
      order,
      cashfreeOrder: {
        orderId: orderNumber,
        paymentSessionId: cfOrder.payment_session_id,
        orderAmount: quote.finalAmount
      },
      appId: process.env.CASHFREE_APP_ID,
      env: process.env.CASHFREE_ENV || 'sandbox'
    });
  } catch (err) {
    logger.error('Quote approve error:', err.message);
    res.status(500).json({ message: 'Failed to process quote' });
  }
});

// POST /api/corporate/quotes/:id/reject
router.post('/:id/reject', async (req, res) => {
  try {
    const quote = await CorporateQuote.findOne({
      _id: req.params.id,
      $or: [{ corporateUserId: req.corporateUser._id }, { contactEmail: req.corporateUser.email }],
      status: 'sent'
    });

    if (!quote) return res.status(404).json({ message: 'Quote not found' });

    quote.status = 'rejected';
    quote.clientNotes = req.body.reason || '';
    await quote.save();

    logActivity({ domain: 'corporate', action: 'quote_rejected', actorRole: 'corporate', actorId: req.corporateUser._id, actorEmail: req.corporateUser.email, targetType: 'CorporateQuote', targetId: quote._id, message: `Quote ${quote.quoteNumber} rejected by ${req.corporateUser.companyName}` });
    res.json({ message: 'Quote rejected', quote });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
