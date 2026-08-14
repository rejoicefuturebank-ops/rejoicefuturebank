// In accounts.js, add at the top after requires:
const checkFrozen = require('../middleware/checkFrozen');

// Apply to deposit endpoint
router.post('/:id/deposit', checkFrozen, async (req, res) => {
    // ... existing deposit code ...
});

// Apply to convert endpoint
router.post('/convert', checkFrozen, async (req, res) => {
    // ... existing convert code ...
});