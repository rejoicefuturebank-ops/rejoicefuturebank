// Update limits - FIXED VERSION
router.put('/:id/limits', rbac(['limits.edit']), async (req, res) => {
    try {
        const userId = req.params.id;
        const limitData = req.body;
        const { reason } = limitData;

        console.log('Updating limits for user:', userId);
        console.log('Limit data received:', limitData);

        if (!reason) {
            return res.status(400).json({ 
                error: 'Reason is required for audit purposes',
                received: limitData
            });
        }

        // Get previous limits for the audit log
        const { data: previous, error: prevError } = await req.supabase
            .from('transfer_limits')
            .select('*')
            .eq('user_id', userId)
            .single();

        if (prevError) {
            console.error('Error fetching previous limits:', prevError);
            return res.status(404).json({ 
                error: 'Could not find existing limits for this user',
                details: prevError.message
            });
        }

        // Prepare update object (exclude 'reason' from actual DB update)
        const updateData = { ...limitData };
        delete updateData.reason;
        updateData.updated_at = new Date().toISOString();

        console.log('Updating with data:', updateData);

        const { data: limits, error: updateError } = await req.supabase
            .from('transfer_limits')
            .update(updateData)
            .eq('user_id', userId)
            .select()
            .single();

        if (updateError) {
            console.error('Supabase update error:', updateError);
            return res.status(500).json({ 
                error: 'Failed to update limits in database',
                details: updateError.message,
                code: updateError.code
            });
        }

        console.log('Limits updated successfully:', limits);

        // Record in audit log
        try {
            await auditLog(req.supabase, {
                actorId: req.admin.id,
                actorType: 'admin',
                action: 'ADMIN_CHANGED_TRANSFER_LIMIT',
                targetType: 'user',
                targetId: userId,
                previousValue: previous,
                newValue: limits,
                reason,
                ip: req.ip,
                userAgent: req.get('user-agent')
            });
        } catch (auditError) {
            console.error('Audit log error (non-critical):', auditError);
            // Don't fail the request if audit log fails
        }

        // Notify the user
        try {
            await req.supabase
                .from('notifications')
                .insert({
                    id: uuidv4(),
                    user_id: userId,
                    type: 'limit_updated',
                    title: 'Your Transfer Limits Have Been Updated',
                    message: `An administrator has updated your account limits. Reason: ${reason}`
                });
        } catch (notifError) {
            console.error('Notification error (non-critical):', notifError);
        }

        res.json({ 
            limits, 
            message: 'Limits updated successfully',
            previous,
            changes: Object.keys(updateData).filter(k => k !== 'updated_at')
        });
    } catch (error) {
        console.error('Update limits error:', error);
        console.error('Stack:', error.stack);
        res.status(500).json({ 
            error: 'Failed to update limits',
            message: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});