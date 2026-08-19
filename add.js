const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../../middleware/auth');
const rbac = require('../../middleware/rbac');
const { auditLog } = require('../../middleware/audit');
const { v4: uuidv4 } = require('uuid');

router.use(authenticateAdmin);