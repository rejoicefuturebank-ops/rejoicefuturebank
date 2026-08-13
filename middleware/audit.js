const { v4: uuidv4 } = require('uuid');

const auditLog = async (supabase, { actorId, actorType, action, targetType, targetId, previousValue, newValue, reason, reference, ip, userAgent, sessionId }) => {
    try {
        await supabase
            .from('audit_logs')
            .insert({
                id: uuidv4(),
                actor_id: actorId,
                actor_type: actorType,
                action,
                target_type: targetType,
                target_id: targetId,
                previous_value: previousValue,
                new_value: newValue,
                reason,
                reference,
                ip_address: ip,
                user_agent: userAgent,
                session_id: sessionId
            });
    } catch (error) {
        console.error('Audit log error:', error);
    }
};

const createAuditMiddleware = (action, targetType) => {
    return async (req, res, next) => {
        const originalJson = res.json.bind(res);

        res.json = function(data) {
            if (res.statusCode >= 200 && res.statusCode < 300) {
                const actor = req.admin || req.user;
                const actorType = req.admin ? 'admin' : 'user';

                auditLog(req.supabase, {
                    actorId: actor?.id,
                    actorType,
                    action,
                    targetType,
                    targetId: req.params.id || data?.id,
                    previousValue: req.previousValue,
                    newValue: data,
                    reason: req.body?.reason,
                    reference: req.body?.reference,
                    ip: req.ip,
                    userAgent: req.get('user-agent'),
                    sessionId: req.sessionId
                });
            }

            return originalJson(data);
        };

        next();
    };
};

module.exports = { auditLog, createAuditMiddleware };