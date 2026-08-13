const jwt = require('jsonwebtoken');

const authenticate = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.token;

        if (!token) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Check impersonation
        if (decoded.impersonation) {
            req.admin = decoded.admin;
            req.user = decoded.user;
            req.isImpersonating = true;
        } else {
            req.user = decoded;
        }

        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expired' });
        }
        return res.status(401).json({ error: 'Invalid token' });
    }
};

const authenticateAdmin = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.admin_token;

        if (!token) {
            return res.status(401).json({ error: 'Admin authentication required' });
        }

        const decoded = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
        req.admin = decoded;

        next();
    } catch (error) {
        return res.status(401).json({ error: 'Invalid admin token' });
    }
};

module.exports = { authenticate, authenticateAdmin };