const { v4: uuidv4 } = require('uuid');

class NotificationService {
    constructor(supabase) {
        this.supabase = supabase;
    }

    async create(userId, type, title, message, channel = 'in_app', metadata = {}) {
        const { data, error } = await this.supabase
            .from('notifications')
            .insert({
                id: uuidv4(),
                user_id: userId,
                type,
                title,
                message,
                channel,
                metadata
            })
            .select()
            .single();

        if (error) console.error('Notification error:', error);
        return data;
    }

    async getUserNotifications(userId, { limit = 20, unreadOnly = false } = {}) {
        let query = this.supabase
            .from('notifications')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (unreadOnly) {
            query = query.eq('is_read', false);
        }

        const { data, error } = await query;
        if (error) throw error;
        return data;
    }

    async markAsRead(notificationId, userId) {
        const { error } = await this.supabase
            .from('notifications')
            .update({ is_read: true })
            .eq('id', notificationId)
            .eq('user_id', userId);

        return !error;
    }

    async markAllAsRead(userId) {
        const { error } = await this.supabase
            .from('notifications')
            .update({ is_read: true })
            .eq('user_id', userId)
            .eq('is_read', false);

        return !error;
    }

    async getUnreadCount(userId) {
        const { count, error } = await this.supabase
            .from('notifications')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('is_read', false);

        return count || 0;
    }
}

module.exports = NotificationService;