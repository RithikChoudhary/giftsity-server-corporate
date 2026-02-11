const express = require('express');
const Order = require('../../server/models/Order');
const Product = require('../../server/models/Product');
const CorporateCatalog = require('../../server/models/CorporateCatalog');
const { createCashfreeOrder, getCashfreeOrder, getCashfreePayments, createRefund } = require('../../server/config/cashfree');
const { requireCorporateAuth, requireActiveStatus, generateDownloadToken } = require('../middleware/corporateAuth');
const { logActivity } = require('../../server/utils/audit');
const { sanitizeBody } = require('../../server/middleware/sanitize');
const { generateOrderInvoice } = require('../../server/utils/pdf');
const { validateCorporateOrder, validatePaymentVerification } = require('../../server/middleware/validators');
const router = express.Router();

router.use(requireCorporateAuth, requireActiveStatus);

// Normalize phone to 10 digits for Cashfree
const normalizePhone = (phone) => {
  const digits = (phone || '').replace(/\D/g, '');
  if (digits.length >= 10) return digits.slice(-10);
  return '9999999999';
};

// Generate corporate order number
const generateOrderNumber = () => {
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = String(Math.floor(Math.random() * 9999)).padStart(4, '0');
  return `GFT-B2B-${date}-${rand}`;
};

// POST /api/corporate/orders - create bulk order
router.post('/', validateCorporateOrder, async (req, res) => {
  try {
    const { items, shippingAddress } = req.body;
    if (!items || !items.length) return res.status(400).json({ message: 'No items' });
    if (!shippingAddress) return res.status(400).json({ message: 'Shipping address required' });

    const corpUser = req.corporateUser;

    // Validate items against corporate catalog
    const sellerGroups = {};
    for (const item of items) {
      const catalogEntry = await CorporateCatalog.findOne({ productId: item.productId, isActive: true });
      if (!catalogEntry) return res.status(400).json({ message: `Product ${item.productId} is not in the corporate catalog` });

      if (item.quantity < catalogEntry.minOrderQty) {
        return res.status(400).json({ message: `Minimum order quantity for this product is ${catalogEntry.minOrderQty}` });
      }
      if (item.quantity > catalogEntry.maxOrderQty) {
        return res.status(400).json({ message: `Maximum order quantity for this product is ${catalogEntry.maxOrderQty}` });
      }

      const product = await Product.findById(item.productId);
      if (!product || !product.isActive) {
        return res.status(400).json({ message: `Product "${item.productId}" is unavailable` });
      }

      // Use corporate price if set, otherwise regular price
      const unitPrice = catalogEntry.corporatePrice || product.price;

      const sid = product.sellerId.toString();
      if (!sellerGroups[sid]) sellerGroups[sid] = [];
      sellerGroups[sid].push({ product, quantity: item.quantity, unitPrice, catalogEntry });
    }

    // Create orders grouped by seller
    const orders = [];
    for (const [sellerId, sellerItems] of Object.entries(sellerGroups)) {
      const itemTotal = sellerItems.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);

      const order = new Order({
        orderNumber: generateOrderNumber(),
        orderType: 'b2b_direct',
        customerId: null, // Corporate orders don't have a regular customer
        customerEmail: corpUser.email,
        customerPhone: corpUser.phone || shippingAddress.phone,
        sellerId,
        items: sellerItems.map(i => ({
          productId: i.product._id,
          title: i.product.title,
          price: i.unitPrice,
          image: i.product.images[0]?.url || '',
          sku: i.product.sku || '',
          quantity: i.quantity,
          sellerId
        })),
        shippingAddress,
        itemTotal,
        shippingCost: 0,
        totalAmount: itemTotal,
        // B2B orders handle commission differently -- set 0 for now
        commissionRate: 0,
        commissionAmount: 0,
        paymentGatewayFee: 0,
        sellerAmount: itemTotal,
        notes: `Corporate order by ${corpUser.companyName} (${corpUser.email})`
      });
      await order.save();
      orders.push(order);
    }

    // Create Cashfree payment
    const grandTotal = orders.reduce((s, o) => s + o.totalAmount, 0);
    const cfOrderId = orders[0].orderNumber;

    const cfOrder = await createCashfreeOrder({
      orderId: cfOrderId,
      orderAmount: grandTotal,
      customerDetails: {
        customerId: corpUser._id.toString(),
        email: corpUser.email,
        phone: normalizePhone(corpUser.phone || shippingAddress.phone),
        name: corpUser.companyName
      },
      returnUrl: `${(process.env.CLIENT_URL || '').split(',')[0].trim() || 'http://localhost:5173'}/corporate/orders?cf_id=${cfOrderId}`
    });

    for (const order of orders) {
      order.cashfreeOrderId = cfOrderId;
      order.paymentSessionId = cfOrder.payment_session_id;
      await order.save();
    }

    for (const order of orders) {
      logActivity({ domain: 'corporate', action: 'corporate_order_created', actorRole: 'corporate', actorId: corpUser._id, actorEmail: corpUser.email, targetType: 'Order', targetId: order._id, message: `Corporate order ${order.orderNumber} created by ${corpUser.companyName}`, metadata: { orderNumber: order.orderNumber, totalAmount: order.totalAmount } });
    }

    res.status(201).json({
      orders,
      cashfreeOrder: {
        orderId: cfOrderId,
        paymentSessionId: cfOrder.payment_session_id,
        orderAmount: grandTotal
      },
      appId: process.env.CASHFREE_APP_ID,
      env: process.env.CASHFREE_ENV || 'sandbox'
    });
  } catch (err) {
    console.error('Corporate create order error:', err?.response?.data || err.message);
    res.status(500).json({ message: 'Failed to create order', error: err.message });
  }
});

// POST /api/corporate/orders/verify-payment
router.post('/verify-payment', validatePaymentVerification, async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ message: 'orderId required' });

    const cfOrder = await getCashfreeOrder(orderId);
    if (cfOrder.order_status !== 'PAID') {
      return res.status(400).json({ message: `Payment not completed. Status: ${cfOrder.order_status}` });
    }

    const payments = await getCashfreePayments(orderId);
    const successPayment = payments.find(p => p.payment_status === 'SUCCESS');

    const orders = await Order.find({ cashfreeOrderId: orderId, customerEmail: req.corporateUser.email });
    if (!orders.length) return res.status(404).json({ message: 'No matching orders found' });

    for (const order of orders) {
      if (order.paymentStatus === 'paid') continue;

      order.paymentStatus = 'paid';
      order.status = 'confirmed';
      order.cashfreePaymentId = successPayment?.cf_payment_id?.toString() || '';
      order.paidAt = new Date();
      await order.save();

      // Atomic stock decrement
      for (const item of order.items) {
        await Product.findOneAndUpdate(
          { _id: item.productId, stock: { $gte: item.quantity } },
          { $inc: { stock: -item.quantity, orderCount: item.quantity } },
          { new: true }
        );
      }
    }

    for (const order of orders) {
      logActivity({ domain: 'corporate', action: 'corporate_payment_verified', actorRole: 'corporate', actorId: req.corporateUser._id, actorEmail: req.corporateUser.email, targetType: 'Order', targetId: order._id, message: `Corporate payment verified for ${order.orderNumber}` });
    }

    res.json({ message: 'Payment verified', orders });
  } catch (err) {
    console.error('Corporate verify payment error:', err.message);
    res.status(500).json({ message: 'Verification failed' });
  }
});

// GET /api/corporate/orders - list orders for this corporate user
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const filter = { orderType: 'b2b_direct', customerEmail: req.corporateUser.email };
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const orders = await Order.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate('sellerId', 'sellerProfile.businessName');
    const total = await Order.countDocuments(filter);

    res.json({ orders, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/corporate/orders/download-token - get a short-lived token for PDF/CSV downloads
router.post('/download-token', async (req, res) => {
  try {
    const token = generateDownloadToken(req.corporateUser._id);
    res.json({ downloadToken: token });
  } catch (err) {
    res.status(500).json({ message: 'Failed to generate download token' });
  }
});

// GET /api/corporate/orders/export/csv - export order history as CSV
router.get('/export/csv', async (req, res) => {
  try {
    const filter = { orderType: 'b2b_direct', customerEmail: req.corporateUser.email };
    const orders = await Order.find(filter).sort({ createdAt: -1 }).lean();

    const header = 'Order Number,Date,Status,Payment Status,Items,Total Amount,Shipping City\n';
    const rows = orders.map(o => {
      const date = new Date(o.createdAt).toISOString().split('T')[0];
      const itemCount = (o.items || []).reduce((s, i) => s + (i.quantity || 1), 0);
      const city = o.shippingAddress?.city || '';
      return `${o.orderNumber},${date},${o.status},${o.paymentStatus},${itemCount},${o.totalAmount},"${city}"`;
    }).join('\n');

    const csv = header + rows;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="orders-${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ message: 'Export failed' });
  }
});

// GET /api/corporate/orders/:id
router.get('/:id', async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, customerEmail: req.corporateUser.email })
      .populate('sellerId', 'sellerProfile.businessName name');
    if (!order) return res.status(404).json({ message: 'Order not found' });
    res.json({ order });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/corporate/orders/:id/invoice - download PDF invoice
router.get('/:id/invoice', async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, customerEmail: req.corporateUser.email }).lean();
    if (!order) return res.status(404).json({ message: 'Order not found' });

    if (order.paymentStatus !== 'paid') {
      return res.status(400).json({ message: 'Invoice is only available for paid orders' });
    }

    const pdfBuffer = await generateOrderInvoice(order, req.corporateUser);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="invoice-${order.orderNumber}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Invoice generation error:', err.message);
    res.status(500).json({ message: 'Failed to generate invoice' });
  }
});

// POST /api/corporate/orders/:id/cancel
router.post('/:id/cancel', sanitizeBody, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, customerEmail: req.corporateUser.email });
    if (!order) return res.status(404).json({ message: 'Order not found' });

    if (!['pending', 'confirmed'].includes(order.status)) {
      return res.status(400).json({ message: `Cannot cancel order with status "${order.status}"` });
    }

    order.status = 'cancelled';
    order.cancelledAt = new Date();
    order.cancelReason = req.body.reason || 'Cancelled by corporate client';
    await order.save();

    if (order.paymentStatus === 'paid') {
      for (const item of order.items) {
        await Product.findByIdAndUpdate(item.productId, { $inc: { stock: item.quantity, orderCount: -item.quantity } });
      }
      try {
        const refundId = `refund_${order.orderNumber}_${Date.now()}`;
        await createRefund({ orderId: order.cashfreeOrderId, refundAmount: order.totalAmount, refundId });
        order.paymentStatus = 'refunded';
        order.refundId = refundId;
      } catch (refundErr) {
        console.error('[Refund] Failed:', refundErr.message);
        order.paymentStatus = 'refund_pending';
      }
      await order.save();
    }

    // Send cancellation confirmation email
    try {
      const { sendCorporateOrderStatusEmail } = require('../../server/utils/email');
      await sendCorporateOrderStatusEmail(req.corporateUser.email, order, 'cancelled');
    } catch (e) { console.error('Cancel confirmation email error:', e.message); }

    logActivity({ domain: 'corporate', action: 'corporate_order_cancelled', actorRole: 'corporate', actorId: req.corporateUser._id, actorEmail: req.corporateUser.email, targetType: 'Order', targetId: order._id, message: `Corporate order ${order.orderNumber} cancelled`, metadata: { reason: order.cancelReason } });
    res.json({ message: 'Order cancelled', order });
  } catch (err) {
    res.status(500).json({ message: 'Failed to cancel order' });
  }
});

module.exports = router;
