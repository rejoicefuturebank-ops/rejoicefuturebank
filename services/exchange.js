class ExchangeService {
    constructor(supabase) {
        this.supabase = supabase;
    }

    async getRate(fromCurrency, toCurrency) {
        if (fromCurrency === toCurrency) return 1;

        // Try direct rate
        let { data: rate } = await this.supabase
            .from('exchange_rates')
            .select('rate')
            .eq('from_currency', fromCurrency)
            .eq('to_currency', toCurrency)
            .single();

        if (rate) return parseFloat(rate.rate);

        // Try inverse
        let { data: inverseRate } = await this.supabase
            .from('exchange_rates')
            .select('rate')
            .eq('from_currency', toCurrency)
            .eq('to_currency', fromCurrency)
            .single();

        if (inverseRate) return 1 / parseFloat(inverseRate.rate);

        // Try via USD
        const usdFrom = await this.getViaUsd(fromCurrency);
        const usdTo = await this.getViaUsd(toCurrency);

        if (usdFrom && usdTo) {
            return usdFrom / usdTo;
        }

        throw new Error(`Exchange rate not available for ${fromCurrency}/${toCurrency}`);
    }

    async getViaUsd(currency) {
        if (currency === 'USD') return 1;

        const { data } = await this.supabase
            .from('exchange_rates')
            .select('rate')
            .eq('from_currency', 'USD')
            .eq('to_currency', currency)
            .single();

        if (data) return parseFloat(data.rate);

        const { data: inverse } = await this.supabase
            .from('exchange_rates')
            .select('rate')
            .eq('from_currency', currency)
            .eq('to_currency', 'USD')
            .single();

        if (inverse) return 1 / parseFloat(inverse.rate);

        return null;
    }

    async convert(amount, fromCurrency, toCurrency) {
        const rate = await this.getRate(fromCurrency, toCurrency);
        const convertedAmount = amount * rate;

        // Apply conversion fee (0.5%)
        const fee = convertedAmount * 0.005;
        const finalAmount = convertedAmount - fee;

        return {
            originalAmount: amount,
            originalCurrency: fromCurrency,
            convertedAmount: parseFloat(finalAmount.toFixed(4)),
            targetCurrency: toCurrency,
            rate,
            fee: parseFloat(fee.toFixed(4))
        };
    }

    async getAllRates(baseCurrency = 'USD') {
        const currencies = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'JPY', 'CNY', 'AED', 'NGN'];
        const rates = {};

        for (const currency of currencies) {
            if (currency !== baseCurrency) {
                try {
                    rates[currency] = await this.getRate(baseCurrency, currency);
                } catch (e) {
                    rates[currency] = null;
                }
            }
        }

        return rates;
    }
}

module.exports = ExchangeService;