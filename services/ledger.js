const { v4: uuidv4 } = require('uuid');

class LedgerService {
    constructor(supabase) {
        this.supabase = supabase;
    }

    async createTransaction({ type, debitAccountId, creditAccountId, amount, currency, fee = 0, description, initiatedBy, metadata = {}, exchangeRate, originalAmount, originalCurrency }) {
        const reference = 'TXN' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2, 5).toUpperCase();

        const { data: transaction, error } = await this.supabase
            .from('transactions')
            .insert({
                id: uuidv4(),
                reference,
                transaction_type: type,
                status: 'pending',
                debit_account_id: debitAccountId,
                credit_account_id: creditAccountId,
                amount,
                currency,
                fee,
                description,
                initiated_by: initiatedBy,
                metadata,
                exchange_rate: exchangeRate,
                original_amount: originalAmount,
                original_currency: originalCurrency
            })
            .select()
            .single();

        if (error) throw error;
        return transaction;
    }

    async completeTransaction(transactionId) {
        const { data: transaction, error } = await this.supabase
            .from('transactions')
            .update({ status: 'completed', completed_at: new Date().toISOString() })
            .eq('id', transactionId)
            .select()
            .single();

        if (error) throw error;

        // Update balances
        if (transaction.debit_account_id) {
            await this.debitAccount(transaction.debit_account_id, transaction.amount);
        }
        if (transaction.credit_account_id) {
            await this.creditAccount(transaction.credit_account_id, transaction.amount);
        }

        return transaction;
    }

    async debitAccount(accountId, amount) {
        const { error } = await this.supabase.rpc('debit_account', {
            p_account_id: accountId,
            p_amount: amount
        });

        // If RPC doesn't exist, do manual update
        if (error) {
            const { data: balance } = await this.supabase
                .from('account_balances')
                .select('available_balance')
                .eq('account_id', accountId)
                .single();

            await this.supabase
                .from('account_balances')
                .update({
                    available_balance: parseFloat(balance.available_balance) - parseFloat(amount),
                    total_withdrawals: this.supabase.rpc ? undefined : parseFloat(balance.available_balance) - parseFloat(amount),
                    updated_at: new Date().toISOString()
                })
                .eq('account_id', accountId);
        }
    }

    async creditAccount(accountId, amount) {
        const { data: balance } = await this.supabase
            .from('account_balances')
            .select('available_balance, total_deposits')
            .eq('account_id', accountId)
            .single();

        await this.supabase
            .from('account_balances')
            .update({
                available_balance: parseFloat(balance.available_balance) + parseFloat(amount),
                total_deposits: parseFloat(balance.total_deposits || 0) + parseFloat(amount),
                updated_at: new Date().toISOString()
            })
            .eq('account_id', accountId);
    }

    async reverseTransaction(transactionId, reason) {
        const { data: transaction } = await this.supabase
            .from('transactions')
            .select('*')
            .eq('id', transactionId)
            .single();

        if (!transaction) throw new Error('Transaction not found');

        // Create reversal transaction
        const reversal = await this.createTransaction({
            type: 'reversal',
            debitAccountId: transaction.credit_account_id,
            creditAccountId: transaction.debit_account_id,
            amount: transaction.amount,
            currency: transaction.currency,
            description: `Reversal of ${transaction.reference}: ${reason}`,
            initiatedBy: transaction.initiated_by,
            metadata: { original_transaction: transactionId, reversal_reason: reason }
        });

        await this.completeTransaction(reversal.id);

        // Mark original as reversed
        await this.supabase
            .from('transactions')
            .update({
                status: 'reversed',
                reversed_at: new Date().toISOString(),
                reversal_reason: reason
            })
            .eq('id', transactionId);

        return reversal;
    }

    async getAccountTransactions(accountId, { limit = 50, offset = 0, status } = {}) {
        let query = this.supabase
            .from('transactions')
            .select('*')
            .or(`debit_account_id.eq.${accountId},credit_account_id.eq.${accountId}`)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (status) {
            query = query.eq('status', status);
        }

        const { data, error } = await query;
        if (error) throw error;
        return data;
    }

    async getTransactionByReference(reference) {
        const { data, error } = await this.supabase
            .from('transactions')
            .select('*')
            .eq('reference', reference)
            .single();

        if (error) return null;
        return data;
    }
}

module.exports = LedgerService;