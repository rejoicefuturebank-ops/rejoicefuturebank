const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const NotificationService = require('../services/notifications');

router.use(authenticate);

// Get notifications
router.get('/', async (req, res) => {
    try {
        const notificationService = new NotificationService(req.supabase);
        const notifications = await notificationService.getUserNotifications(req.user.id, { limit: 50 });
        const unreadCount = await notificationService.getUnreadCount(req.user.id);

        res.json({ notifications, unreadCount });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch notifications' });
    }
});

// Mark as read
router.put('/:id/read', async (req, res) => {
    try {
        const notificationService = new NotificationService(req.supabase);
        await notificationService.markAsRead(req.params.id, req.user.id);
        res.json({ message: 'Marked as read' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to mark as read' });
    }
});

// Mark all as read
router.put('/read-all', async (req, res) => {
    try {
        const notificationService = new NotificationService(req.supabase);
        await notificationService.markAllAsRead(req.user.id);
        res.json({ message: 'All marked as read' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to mark all as read' });
    }
});

module.exports = router;