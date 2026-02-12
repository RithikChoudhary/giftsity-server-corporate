const express = require('express');
const CorporateCatalog = require('../../server/models/CorporateCatalog');
const Product = require('../../server/models/Product');
const { requireCorporateAuth, requireActiveStatus } = require('../middleware/corporateAuth');
const logger = require('../../server/utils/logger');
const router = express.Router();

// Helper to escape user input for safe use in RegExp (prevents ReDoS)
const escapeRegex = (str) => (typeof str === 'string' ? str : '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

router.use(requireCorporateAuth, requireActiveStatus);

// GET /api/corporate/catalog - browse curated corporate catalog
router.get('/', async (req, res) => {
  try {
    const { search, tag, category, minPrice, maxPrice, sort, page = 1, limit = 24 } = req.query;

    const catalogFilter = { isActive: true };
    if (tag) catalogFilter.tags = tag;

    const catalogEntries = await CorporateCatalog.find(catalogFilter)
      .populate({
        path: 'productId',
        match: { isActive: true, stock: { $gt: 0 } },
        populate: { path: 'sellerId', select: 'sellerProfile.businessName sellerProfile.avatar' }
      })
      .lean();

    // Filter out null products (deleted/inactive)
    let products = catalogEntries
      .filter(e => e.productId)
      .map(e => ({
        ...e.productId,
        corporatePrice: e.corporatePrice,
        minOrderQty: e.minOrderQty,
        maxOrderQty: e.maxOrderQty,
        catalogId: e._id,
        tags: e.tags
      }));

    // Apply additional filters
    if (search && typeof search === 'string') {
      const regex = new RegExp(escapeRegex(search), 'i');
      products = products.filter(p => regex.test(p.title) || regex.test(p.description));
    }
    if (category) {
      products = products.filter(p => p.category === category);
    }
    if (minPrice) {
      products = products.filter(p => (p.corporatePrice || p.price) >= Number(minPrice));
    }
    if (maxPrice) {
      products = products.filter(p => (p.corporatePrice || p.price) <= Number(maxPrice));
    }

    // Sort
    if (sort === 'price_asc') products.sort((a, b) => (a.corporatePrice || a.price) - (b.corporatePrice || b.price));
    else if (sort === 'price_desc') products.sort((a, b) => (b.corporatePrice || b.price) - (a.corporatePrice || a.price));
    else if (sort === 'popular') products.sort((a, b) => (b.orderCount || 0) - (a.orderCount || 0));
    else products.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const total = products.length;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const paged = products.slice(skip, skip + parseInt(limit));

    // Get all unique tags for filter sidebar
    const allTags = [...new Set(catalogEntries.flatMap(e => e.tags || []))];

    res.json({ products: paged, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)), tags: allTags });
  } catch (err) {
    logger.error('Corporate catalog error:', err.message);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/corporate/catalog/:id - single product detail
router.get('/:id', async (req, res) => {
  try {
    const entry = await CorporateCatalog.findOne({ productId: req.params.id, isActive: true })
      .populate({
        path: 'productId',
        populate: { path: 'sellerId', select: 'sellerProfile.businessName sellerProfile.avatar sellerProfile.isVerified' }
      });

    if (!entry || !entry.productId) {
      return res.status(404).json({ message: 'Product not found in corporate catalog' });
    }

    const product = entry.productId.toObject();
    product.corporatePrice = entry.corporatePrice;
    product.minOrderQty = entry.minOrderQty;
    product.maxOrderQty = entry.maxOrderQty;
    product.catalogId = entry._id;
    product.tags = entry.tags;

    res.json({ product });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
