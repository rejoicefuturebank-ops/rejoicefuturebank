// Admin Application Module
const AdminApp = {
    adminData: null,

    init() {
        this.adminData = JSON.parse(localStorage.getItem('admin_data'));
        this.setupNavigation();
        this.loadDashboard();
        this.updateAdminInfo();
    },

    updateAdminInfo() {
        if (this.adminData?.admin) {
            document.getElementById('adminName').textContent =
                `${this.adminData.admin.first_name} ${this.adminData.admin.last_name}`;
            document.getElementById('adminRole').textContent = this.adminData.admin.role;
        }
    },

    setupNavigation() {
        document.querySelectorAll('.admin-nav .nav-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                const section = item.dataset.section;
                this.switchSection(section);
            });
        });

        document.getElementById('adminLogoutBtn')?.addEventListener('click', () => {
            API.clearTokens();
            localStorage.clear();
            window.location.reload();
        });
    },

    switchSection(section) {
        document.querySelectorAll('.admin-nav .nav-item').forEach(n => n.classList.remove('active'));
        document.querySelectorAll('.admin-section').forEach(s => s.classList.remove('active'));

        document.querySelector(`[data-section="${section}"]`)?.classList.add('active');
        document.getElementById(`admin-section-${section.replace('admin-', '')}`)?.classList.add('active');

        // Set page title
        const titles = {
            'admin-dashboard': 'Dashboard',
            'admin-users': 'User Management',
            'admin-accounts': 'All Accounts',
            'admin-transactions': 'Transactions',
            'admin-support': 'Support Tickets',
            'admin-balances': 'Balance Adjustments',
            'admin-limits': 'Transfer Limits',
            'admin-audit': 'Audit Logs',
            'admin-settings': 'System Settings',
            'admin-simulation': 'Simulation Center',
            'admin-impersonation': 'Test Mode',
            'admin-security': 'Security Events',
            'admin-otp': 'OTP Configuration',
            'admin-fraud': 'Fraud Detection',
            'admin-reports': 'Reports'
        };
        document.getElementById('adminPageTitle').textContent = titles[section] || 'Dashboard';

        // Load section data
        switch (section) {
            case 'admin-dashboard': this.loadDashboard(); break;
            case 'admin-users': if (typeof AdminUsers !== 'undefined') AdminUsers.init(); break;
            case 'admin-balances': if (typeof AdminBalances !== 'undefined') AdminBalances.init(); break;
            case 'admin-support': if (typeof AdminSupport !== 'undefined') AdminSupport.init(); break;
            case 'admin-audit': if (typeof AdminAudit !== 'undefined') AdminAudit.init(); break;
            case 'admin-limits': if (typeof AdminLimits !== 'undefined') AdminLimits.init(); break;
            case 'admin-simulation': this.initSimulation(); break;
            case 'admin-impersonation': if (typeof AdminImpersonation !== 'undefined') AdminImpersonation.init(); break;
            case 'admin-settings': this.loadSettings(); break;
            case 'admin-reports': if (typeof AdminReports !== 'undefined') AdminReports.init(); break;
        }
    },

    async loadDashboard() {
        try {
            const stats = await API.admin.getDashboardStats();

            document.getElementById('statTotalUsers').textContent = stats.totalUsers || 0;
            document.getElementById('statActiveUsers').textContent = stats.activeUsers || 0;
            document.getElementById('statTotalBalance').textContent = Utils.formatCurrency(stats.totalBalanceUSD || 0);
            document.getElementById('statTransactions').textContent = stats.totalTransactions || 0;
            document.getElementById('statPending').textContent = stats.pendingTransactions || 0;
            document.getElementById('statOpenTickets').textContent = stats.openTickets || 0;
        } catch (error) {
            console.error('Dashboard load error:', error);
        }
    },

    initSimulation() {
        document.querySelectorAll('.btn-sim').forEach(btn => {
            btn.addEventListener('click', async () => {
                const scenario = btn.dataset.scenario;
                const reason = prompt('Enter a reason for this simulation (for audit):');
                if (!reason) return;

                try {
                    // Use the first user for simulation
                    const users = await API.admin.searchUsers('');
                    const userId = users.users?.[0]?.id;
                    const accountId = users.users?.[0]?.accounts?.[0]?.id;

                    await API.admin.simulate(scenario, {
                        user_id: userId,
                        account_id: accountId,
                        amount: 100,
                        reason
                    });
                    Utils.showToast(`Simulation "${scenario}" executed successfully!`, 'success');
                } catch (error) {
                    Utils.showToast(`Simulation failed: ${error.message}`, 'error');
                }
            });
        });
    },

    async loadSettings() {
        try {
            const settings = await API.admin.getSettings();
            const container = document.getElementById('settingsContent');

            container.innerHTML = Object.entries(settings).map(([key, value]) => `
                <div class="form-group">
                    <label>${key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}</label>
                    <input type="text" value='${JSON.stringify(value)}' data-key="${key}" class="setting-input">
                </div>
            `).join('') + '<button class="btn btn-primary" id="saveSettingsBtn">Save Settings</button>';

            document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
                const inputs = document.querySelectorAll('.setting-input');
                for (const input of inputs) {
                    try {
                        const value = JSON.parse(input.value);
                        await API.admin.updateSetting(input.dataset.key, value);
                    } catch (e) {
                        Utils.showToast(`Invalid JSON for ${input.dataset.key}`, 'error');
                    }
                }
                Utils.showToast('Settings saved!', 'success');
            });
        } catch (error) {
            console.error('Settings load error:', error);
        }
    }
};

// Admin Impersonation Module
const AdminImpersonation = {
    init() {
        this.setupSearch();
        this.setupForm();
    },

    setupSearch() {
        const searchInput = document.getElementById('impersonateUserSearch');
        const resultsDiv = document.getElementById('impersonateUserResults');

        let debounceTimer;
        searchInput?.addEventListener('input', (e) => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(async () => {
                const q = e.target.value.trim();
                if (q.length < 2) {
                    resultsDiv.innerHTML = '';
                    return;
                }

                try {
                    const response = await API.admin.searchUsers(q);
                    const users = response.users || [];

                    resultsDiv.innerHTML = users.slice(0, 5).map(u => `
                        <div class="search-result-item" data-id="${u.id}" data-name="${u.profiles?.full_name || u.email}">
                            ${u.profiles?.full_name || 'No name'} - ${u.email}
                        </div>
                    `).join('');

                    resultsDiv.querySelectorAll('.search-result-item').forEach(item => {
                        item.addEventListener('click', () => {
                            searchInput.value = item.dataset.name;
                            searchInput.dataset.userId = item.dataset.id;
                            resultsDiv.innerHTML = '';
                        });
                    });
                } catch (error) {
                    console.error('Search error:', error);
                }
            }, 300);
        });
    },

    setupForm() {
        document.getElementById('impersonationForm')?.addEventListener('submit', async (e) => {
            e.preventDefault();

            const searchInput = document.getElementById('impersonateUserSearch');
            const userId = searchInput.dataset.userId;
            const reason = document.getElementById('impersonateReason').value;

            if (!userId) {
                Utils.showToast('Please select a user', 'error');
                return;
            }

            if (!confirm('You are about to enter test mode as this user. All actions will be audited. Continue?')) {
                return;
            }

            try {
                const response = await API.admin.startImpersonation(userId, reason);

                // Save the impersonation token
                localStorage.setItem('banking_token', response.token);
                localStorage.setItem('impersonation_session', response.sessionId);

                Utils.showToast('Entering test mode...', 'success');
                setTimeout(() => {
                    window.location.href = '/dashboard.html';
                }, 500);
            } catch (error) {
                Utils.showToast(error.message, 'error');
            }
        });
    }
};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    if (window.location.pathname.includes('admin.html')) {
        if (Utils.isAdminAuthenticated()) {
            document.getElementById('adminLoginView').style.display = 'none';
            document.getElementById('adminDashboardView').style.display = 'flex';
            AdminApp.init();
        }
    }
});