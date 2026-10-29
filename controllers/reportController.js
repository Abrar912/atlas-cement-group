const { getDbConnection } = require('../config/database');
const { likeContains } = require('../utils/sqlSafety');

// Helper function to normalize Shamsi dates to YYYY/MM/DD format with zero-padding
function normalizeShamsiDate(dateStr) {
    if (!dateStr) return '';
    const parts = String(dateStr).replace(/-/g, '/').trim().split('/');
    if (parts.length !== 3) return dateStr;
    const y = parts[0];
    const m = parts[1].padStart(2, '0');
    const day = parts[2].padStart(2, '0');
    return `${y}/${m}/${day}`;
}

function apiAgentLogSubmissions(req, res) {
    console.log('[DEBUG] apiAgentLogSubmissions called - Session role:', req.session.role, 'User ID:', req.session.user_id);
    
    if (!req.session.role || req.session.role !== 'admin') {
        console.error('[ERROR] Unauthorized access attempt - Role:', req.session.role);
        return res.status(403).json({ error: 'Unauthorized - Admin access required' });
    }
    
    const db = getDbConnection();
    
    // Get filter parameters
    const province = req.query.province || 'All';
    const agent = req.query.agent || 'All';
    const balance = req.query.balance || 'All';
    const customerId = req.query.customer_id || 'All';
    const cement = req.query.cement || 'All';
    const truck = req.query.truck || 'All';
    const startDate = req.query.start_date || '';
    const endDate = req.query.end_date || '';
    const searchDriver = req.query.search_driver || '';
    const searchWaybill = req.query.search_waybill || '';
    
    // Advanced customer search parameters
    const searchCustId = req.query.search_cust_id || '';
    const searchCustName = req.query.search_cust_name || '';
    const searchCustProvince = req.query.search_cust_province || 'All';
    const searchCustAgent = req.query.search_cust_agent || 'All';
    const searchCustPhone = req.query.search_cust_phone || '';
    const searchCustAddress = req.query.search_cust_address || '';
    const searchCustEmail = req.query.search_cust_email || '';
    
    console.log('[DEBUG] Filter parameters:', { province, agent, balance, customerId, cement, truck, startDate, endDate, searchDriver, searchWaybill });
    console.log('[DEBUG] Customer search parameters:', { searchCustId, searchCustName, searchCustProvince, searchCustAgent, searchCustPhone, searchCustAddress, searchCustEmail });
    
    // Build base query
    let query = `
        SELECT
            sl.id,
            sl.sale_date,
            COALESCE(lw.waybill_date, sl.sale_date) AS loading_date,
            c.id as customer_id,
            c.name as customer_name,
            c.province as customer_province,
            c.customer_id as customer_customer_id,
            c.phone as customer_phone,
            c.address as customer_address,
            c.email as customer_email,
            c.created_by_agency as customer_agency_short,
            au.agency_name as customer_agency,
            sl.driver_name,
            COALESCE(lw.driver_phone, c.phone) as driver_phone,
            sl.car_plate,
            sl.waybill_number,
            sl.cement_type,
            sl.bags_count,
            sl.tonnage,
            sl.shortage,
            sl.unit_price_bag,
            sl.total_sales_money,
            sl.freight_per_ton,
            sl.total_freight,
            sl.net_cement_money,
            sl.is_posted,
            sl.is_company_car,
            sl.province_origin,
            u.username as submitted_by,
            u.agency_name as submitted_by_agency,
            lw.truck_type
        FROM sales_logs sl
        LEFT JOIN customers c ON sl.customer_id = c.id
        LEFT JOIN users u ON sl.user_id = u.id
        LEFT JOIN users au ON c.created_by = au.username
        LEFT JOIN local_waybills lw ON sl.waybill_number = lw.waybill_serial
        WHERE 1=1
    `;
    
    const params = [];
    
    // Apply filters
    if (province !== 'All') {
        query += ` AND c.province = ?`;
        params.push(province);
    }
    
    if (agent !== 'All') {
        query += ` AND (c.created_by_agency = ? OR au.agency_name = ?)`;
        params.push(agent, agent);
    }
    
    if (customerId !== 'All') {
        query += ` AND c.id = ?`;
        params.push(parseInt(customerId));
    }
    
    if (cement !== 'All') {
        query += ` AND sl.cement_type = ?`;
        params.push(cement);
    }
    
    if (truck !== 'All') {
        // Filter by total_freight value from sales_logs
        // Rental vehicles have freight > 0, Company vehicles have freight = 0
        if (truck === 'Rental') {
            query += ` AND (sl.total_freight IS NOT NULL AND sl.total_freight > 0)`;
        } else if (truck === 'Company') {
            query += ` AND (sl.total_freight IS NULL OR sl.total_freight = 0)`;
        }
    }
    
    if (startDate) {
        // Normalize date: convert hyphens to slashes and pad with zeros for Shamsi date comparison
        const normalizedStartDate = normalizeShamsiDate(startDate);
        query += ` AND sl.sale_date >= ?`;
        params.push(normalizedStartDate);
        console.log('[DEBUG] Date filter - Start date (normalized):', normalizedStartDate, 'Original:', startDate);
    }
    
    if (endDate) {
        // Normalize date: convert hyphens to slashes and pad with zeros for Shamsi date comparison
        const normalizedEndDate = normalizeShamsiDate(endDate);
        query += ` AND sl.sale_date <= ?`;
        params.push(normalizedEndDate);
        console.log('[DEBUG] Date filter - End date (normalized):', normalizedEndDate, 'Original:', endDate);
    }
    
    if (searchDriver) {
        query += ` AND LOWER(sl.driver_name) LIKE ? ESCAPE '\\'`;
        params.push(likeContains(searchDriver.toLowerCase()));
    }
    
    if (searchWaybill) {
        query += ` AND LOWER(sl.waybill_number) LIKE ? ESCAPE '\\'`;
        params.push(likeContains(searchWaybill.toLowerCase()));
    }
    
    // Apply advanced customer search with partial matching
    if (searchCustId) {
        query += ` AND LOWER(c.customer_id) LIKE ? ESCAPE '\\'`;
        params.push(likeContains(searchCustId.toLowerCase()));
    }
    
    if (searchCustName) {
        query += ` AND LOWER(c.name) LIKE ? ESCAPE '\\'`;
        params.push(likeContains(searchCustName.toLowerCase()));
    }
    
    if (searchCustProvince !== 'All') {
        query += ` AND c.province = ?`;
        params.push(searchCustProvince);
    }
    
    if (searchCustAgent !== 'All') {
        query += ` AND (c.created_by_agency = ? OR c.created_by = ?)`;
        params.push(searchCustAgent, searchCustAgent);
    }
    
    if (searchCustPhone) {
        query += ` AND LOWER(c.phone) LIKE ? ESCAPE '\\'`;
        params.push(likeContains(searchCustPhone.toLowerCase()));
    }
    
    if (searchCustAddress) {
        query += ` AND LOWER(c.address) LIKE ? ESCAPE '\\'`;
        params.push(likeContains(searchCustAddress.toLowerCase()));
    }
    
    if (searchCustEmail) {
        query += ` AND LOWER(c.email) LIKE ? ESCAPE '\\'`;
        params.push(likeContains(searchCustEmail.toLowerCase()));
    }
    
    query += ` ORDER BY sl.id DESC`;
    
    console.log('[DEBUG] Executing query with params:', params);
    
    try {
        db.all(query, params, (err, rows) => {
            if (err) {
                console.error('[ERROR] Database error in apiAgentLogSubmissions:', err);
                console.error('[ERROR] SQL Error Details:', err.message);
                db.close();
                return res.status(500).json({ error: 'Database error', details: 'Internal error' });
            }
            
            console.log('[DEBUG] Query successful - Rows returned:', rows.length);
            
            // Log sample dates for debugging
            if (rows.length > 0) {
                console.log('[DEBUG] Sample sale_date from first row:', rows[0].sale_date);
                console.log('[DEBUG] Date filter params - Start:', startDate, 'End:', endDate);
            }
            
            // Fetch customer balances for balance category filtering
            db.all('SELECT customer_id, SUM(net_cement_money) as total_debit FROM sales_logs GROUP BY customer_id', (err, salesSums) => {
                if (err) {
                    console.error('[ERROR] Error fetching sales sums for balance filter:', err);
                    db.close();
                    return res.status(500).json({ error: 'Database error' });
                }
                
                db.all('SELECT customer_id, SUM(amount_received) as total_credit FROM receipts_logs GROUP BY customer_id', (err, receiptSums) => {
                    if (err) {
                        console.error('[ERROR] Error fetching receipt sums for balance filter:', err);
                        db.close();
                        return res.status(500).json({ error: 'Database error' });
                    }
                
                const debits = {};
                const credits = {};
                
                salesSums.forEach(row => {
                    debits[row.customer_id] = row.total_debit;
                });
                
                receiptSums.forEach(row => {
                    credits[row.customer_id] = row.total_credit;
                });
                
                // Calculate customer net balances
                const customerBalances = {};
                const allCustIds = new Set([...Object.keys(debits), ...Object.keys(credits)]);
                allCustIds.forEach(cId => {
                    customerBalances[cId] = (debits[cId] || 0.0) - (credits[cId] || 0.0);
                });
                
                // Attach customer balance to each row
                const rowsWithBalance = rows.map(row => {
                    return {
                        ...row,
                        customer_balance: customerBalances[row.customer_id] || 0
                    };
                });
                
                // Apply balance category filter on the results using customer net balances
                let filteredRows = rowsWithBalance;
                if (balance !== 'All') {
                    filteredRows = rowsWithBalance.filter(row => {
                        const customerNetBalance = row.customer_balance || 0;
                        if (balance === 'Green') return customerNetBalance > 0.1;
                        if (balance === 'Red') return customerNetBalance < -0.1;
                        if (balance === 'Zero') return Math.abs(customerNetBalance) <= 0.1;
                        return true;
                    });
                }
                
                db.close();
                res.json({ records: filteredRows });
            });
        });
    });
    } catch (error) {
        console.error('[ERROR] Unexpected error in apiAgentLogSubmissions:', error);
        db.close();
        return res.status(500).json({ error: 'Server error', details: 'Internal error' });
    }
}

function apiDailySalesReport(req, res) {
    if (!req.session.role) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const selectedDate = req.query.date;
    
    if (!selectedDate) {
        return res.status(400).json({ error: 'Date parameter required' });
    }
    
    const db = getDbConnection();

    // H3/H4: non-admin users may only see transactions of customers they own.
    const workerScope = req.session.role === 'admin' ? '' : ' AND LOWER(customers.created_by) = LOWER(?)';
    const workerScopeParams = workerScope ? [req.session.username] : [];

    // Query sales_logs for the selected date.
    // F-A1: the previous query referenced non-existent columns (sales_logs.date,
    // .truck_type, .bags) and joined on the TEXT display code
    // customers.customer_id while sales_logs.customer_id is the INTEGER FK to
    // customers.id — SQLite rejected it with "no such column" and the endpoint
    // returned 500 for everyone. Column semantics preserved: sale_date is the
    // date, bags_count the bag count, is_company_car=1 maps to 'Company'
    // (same CASE pattern as workerController/adminController truck counters).
    const salesQuery = `
        SELECT 
            sales_logs.sale_date as date,
            sales_logs.customer_id,
            customers.name as customer_name,
            customers.province,
            'Sale' as transaction_type,
            CASE WHEN sales_logs.is_company_car = 1 THEN 'Company' ELSE 'Private' END as truck_type,
            sales_logs.bags_count as bags,
            sales_logs.net_cement_money as amount
        FROM sales_logs
        JOIN customers ON sales_logs.customer_id = customers.id
        WHERE sales_logs.sale_date = ?
    `;
    
    // Query receipts_logs for the selected date
    const receiptsQuery = `
        SELECT 
            receipts_logs.receipt_date as date,
            receipts_logs.customer_id,
            customers.name as customer_name,
            customers.province,
            'Receipt' as transaction_type,
            NULL as truck_type,
            NULL as bags,
            receipts_logs.amount_received as amount
        FROM receipts_logs
        JOIN customers ON receipts_logs.customer_id = customers.id
        WHERE receipts_logs.receipt_date = ?
    `;
    
    db.all(salesQuery + workerScope, [selectedDate, ...workerScopeParams], (err, sales) => {
        if (err) {
            db.close();
            return res.status(500).json({ error: 'Database error' });
        }
        
        db.all(receiptsQuery + workerScope, [selectedDate, ...workerScopeParams], (err, receipts) => {
            if (err) {
                db.close();
                return res.status(500).json({ error: 'Database error' });
            }
            
            // Combine and sort transactions
            const allTransactions = [...sales, ...receipts].sort((a, b) => a.date.localeCompare(b.date));
            
            // Calculate totals with explicit 0 fallback
            let totalRevenue = 0;
            let totalReceipts = 0;
            let totalBags = 0;
            let companyTrucks = 0;
            let privateTrucks = 0;
            
            if (sales && sales.length > 0) {
                sales.forEach(sale => {
                    totalRevenue += (sale.amount || 0);
                    totalBags += (sale.bags || 0);
                    if (sale.truck_type === 'Company') {
                        companyTrucks++;
                    } else if (sale.truck_type === 'Private') {
                        privateTrucks++;
                    }
                });
            }
            
            if (receipts && receipts.length > 0) {
                receipts.forEach(receipt => {
                    totalReceipts += (receipt.amount || 0);
                });
            }
            
            const totalTrucks = companyTrucks + privateTrucks;
            
            db.close();
            
            res.json({
                total_revenue: totalRevenue,
                total_receipts: totalReceipts,
                total_bags: totalBags,
                total_trucks: totalTrucks,
                company_trucks: companyTrucks,
                private_trucks: privateTrucks,
                transactions: allTransactions
            });
        });
    });
}

function apiCustomerDetails(req, res) {
    if (!req.session.role) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const customerId = req.query.customer_id;
    
    if (!customerId) {
        return res.status(400).json({ error: 'Customer ID required' });
    }
    
    const db = getDbConnection();
    
    // Fetch customer profile details
    db.get('SELECT * FROM customers WHERE id = ?', [customerId], (err, customer) => {
        if (err) {
            db.close();
            return res.status(500).json({ error: 'Database error' });
        }
        
        if (!customer) {
            db.close();
            return res.status(404).json({ error: 'Customer not found' });
        }

        // H3/H4: workers may only view customers they created. Respond 404
        // (not 403) for foreign ids so the reply does not reveal existence.
        if (req.session.role !== 'admin' &&
            String(customer.created_by || '').toLowerCase() !== String(req.session.username || '').toLowerCase()) {
            db.close();
            return res.status(404).json({ error: 'Customer not found' });
        }

        // Fetch financial summary
        db.get("SELECT SUM(total_sales_money) as total_gross, SUM(net_cement_money) as total_debit, SUM(bags_count) as total_bags, SUM(tonnage) as total_tons FROM sales_logs WHERE customer_id = ?", [customer.id], (err, salesData) => {
            if (err) {
                db.close();
                return res.status(500).json({ error: 'Database error' });
            }
            
            db.get("SELECT SUM(amount_received) as total_credit FROM receipts_logs WHERE customer_id = ?", [customer.id], (err, creditData) => {
                if (err) {
                    db.close();
                    return res.status(500).json({ error: 'Database error' });
                }
                
                // Fetch user/creator information if available
                // Try to find the user who created this customer by username
                let creatorQuery = 'SELECT username, role, assigned_province, agency_name FROM users WHERE ';
                let creatorParams = [];

                if (customer.created_by) {
                    creatorQuery += 'username = ?';
                    creatorParams.push(customer.created_by);
                } else {
                    // No creator info available
                    creatorQuery = null;
                }

                if (creatorQuery) {
                    db.get(creatorQuery, creatorParams, (err, userInfo) => {
                        const totalGross = salesData.total_gross || 0.0;
                        const totalDebit = salesData.total_debit || 0.0;
                        const totalBags = salesData.total_bags || 0;
                        const totalTons = salesData.total_tons || 0.0;
                        const totalCredit = creditData.total_credit || 0.0;
                        const netBalance = totalDebit - totalCredit;

                        db.close();

                        res.json({
                            customer: {
                                id: customer.id,
                                customer_id: customer.customer_id,
                                name: customer.name,
                                customer_type: customer.customer_type,
                                organization_name: customer.organization_name,
                                contact_person_position: customer.contact_person_position,
                                province: customer.province,
                                phone: customer.phone,
                                alternative_phone: customer.alternative_phone,
                                email: customer.email,
                                address: customer.address,
                                created_by_agency: customer.created_by_agency
                            },
                            creator: userInfo ? {
                                username: userInfo.username,
                                role: userInfo.role,
                                assigned_province: userInfo.assigned_province,
                                agency_name: userInfo.agency_name
                            } : null,
                            financial: {
                                total_gross: totalGross,
                                total_debit: totalDebit,
                                total_credit: totalCredit,
                                net_balance: netBalance,
                                total_bags: totalBags,
                                total_tons: totalTons
                            }
                        });
                    });
                } else {
                    // No creator query, return without creator info
                    const totalGross = salesData.total_gross || 0.0;
                    const totalDebit = salesData.total_debit || 0.0;
                    const totalBags = salesData.total_bags || 0;
                    const totalTons = salesData.total_tons || 0.0;
                    const totalCredit = creditData.total_credit || 0.0;
                    const netBalance = totalDebit - totalCredit;
                    
                    db.close();
                    
                    res.json({
                        customer: {
                            id: customer.id,
                            customer_id: customer.customer_id,
                            name: customer.name,
                            customer_type: customer.customer_type,
                            organization_name: customer.organization_name,
                            contact_person_position: customer.contact_person_position,
                            province: customer.province,
                            phone: customer.phone,
                            alternative_phone: customer.alternative_phone,
                            email: customer.email,
                            address: customer.address,
                            created_by_agency: customer.created_by_agency
                        },
                        creator: null,
                        financial: {
                            total_gross: totalGross,
                            total_debit: totalDebit,
                            total_credit: totalCredit,
                            net_balance: netBalance,
                            total_bags: totalBags,
                            total_tons: totalTons
                        }
                    });
                }
            });
        });
    });
}

function apiRemittanceLedger(req, res) {
    console.log('[DEBUG] apiRemittanceLedger called - Session role:', req.session.role, 'User ID:', req.session.user_id);
    
    // H3/H4: admin-only. Workers have their own scoped endpoint
    // (/api/worker/remittance-ledger); this one feeds the admin ledger page.
    if (!req.session.role || req.session.role !== 'admin') {
        console.error('[ERROR] Unauthorized access attempt - Role:', req.session.role);
        return res.status(403).json({ error: 'Unauthorized - Admin access required' });
    }
    
    const db = getDbConnection();
    const userRole = req.session.role;
    
    // Get filter parameters
    const province = req.query.province || 'All';
    const balance = req.query.balance || 'All';
    const customerId = req.query.customer_id || 'All';
    const source = req.query.source || 'All';
    const agencyFilter = req.query.agency || 'All';
    const userFilter = req.query.user || 'All';
    const startDate = req.query.start_date || '';
    const endDate = req.query.end_date || '';
    
    // Search parameters
    const searchSender = req.query.search_sender || '';
    const searchSourceName = req.query.search_source_name || '';
    const searchRemittanceNumber = req.query.search_remittance_number || '';
    const searchAmount = req.query.search_amount || '';
    
    console.log('[DEBUG] Filter parameters:', { province, balance, customerId, source, agencyFilter, userFilter, startDate, endDate });
    console.log('[DEBUG] Search parameters:', { searchSender, searchSourceName, searchRemittanceNumber, searchAmount });
    
    // Build base query joining receipts_logs with customers and users
    let query = `
        SELECT 
            rl.id,
            rl.receipt_date,
            c.id as customer_id,
            c.customer_id as customer_customer_id,
            c.name as customer_name,
            c.province as customer_province,
            rl.sender_name,
            rl.origin_source,
            rl.remittance_number,
            rl.receiving_station,
            rl.amount_received,
            u.username as submitted_by,
            u.agency_name as agency
        FROM receipts_logs rl
        INNER JOIN customers c ON rl.customer_id = c.id
        LEFT JOIN users u ON rl.user_id = u.id
        WHERE 1=1
    `;
    
    const params = [];
    
    // (Endpoint is admin-only since H3/H4; no per-role row filter needed.)
    
    // Province filter
    if (province && province !== 'All') {
        query += ` AND c.province = ?`;
        params.push(province);
    }
    
    // Customer filter
    if (customerId && customerId !== 'All') {
        query += ` AND c.id = ?`;
        params.push(customerId);
    }
    
    // Source filter - use origin_source_type for proper filtering by source type
    if (source && source !== 'All') {
        query += ` AND rl.origin_source_type = ?`;
        params.push(source);
    }
    
    // Agency filter (admin only)
    if (userRole === 'admin' && agencyFilter && agencyFilter !== 'All') {
        query += ` AND u.agency_name = ?`;
        params.push(agencyFilter);
    }
    
    // User filter (admin only)
    if (userRole === 'admin' && userFilter && userFilter !== 'All') {
        query += ` AND u.username = ?`;
        params.push(userFilter);
    }
    
    // Date range filter
    if (startDate) {
        const normalizedStartDate = normalizeShamsiDate(startDate);
        query += ` AND rl.receipt_date >= ?`;
        params.push(normalizedStartDate);
    }
    
    if (endDate) {
        const normalizedEndDate = normalizeShamsiDate(endDate);
        query += ` AND rl.receipt_date <= ?`;
        params.push(normalizedEndDate);
    }
    
    // Sender name search
    if (searchSender) {
        query += ` AND rl.sender_name LIKE ? ESCAPE '\\'`;
        params.push(likeContains(searchSender));
    }
    
    // Source name search
    if (searchSourceName) {
        query += ` AND rl.origin_source LIKE ? ESCAPE '\\'`;
        params.push(likeContains(searchSourceName));
    }
    
    // Remittance number search
    if (searchRemittanceNumber) {
        query += ` AND rl.remittance_number LIKE ? ESCAPE '\\'`;
        params.push(likeContains(searchRemittanceNumber));
    }
    
    // Amount search
    if (searchAmount) {
        query += ` AND rl.amount_received = ?`;
        params.push(parseFloat(searchAmount));
    }
    
    // Balance filter (based on customer's net balance)
    if (balance && balance !== 'All') {
        if (balance === 'Greens') {
            query += ` AND (SELECT COALESCE(SUM(sl.total_sales_money - sl.total_freight), 0) FROM sales_logs sl WHERE sl.customer_id = c.id) - (SELECT COALESCE(SUM(r.amount_received), 0) FROM receipts_logs r WHERE r.customer_id = c.id) > 0.1`;
        } else if (balance === 'Reds') {
            query += ` AND (SELECT COALESCE(SUM(sl.total_sales_money - sl.total_freight), 0) FROM sales_logs sl WHERE sl.customer_id = c.id) - (SELECT COALESCE(SUM(r.amount_received), 0) FROM receipts_logs r WHERE r.customer_id = c.id) < -0.1`;
        } else if (balance === 'Zeros') {
            query += ` AND ABS((SELECT COALESCE(SUM(sl.total_sales_money - sl.total_freight), 0) FROM sales_logs sl WHERE sl.customer_id = c.id) - (SELECT COALESCE(SUM(r.amount_received), 0) FROM receipts_logs r WHERE r.customer_id = c.id)) <= 0.1`;
        }
    }
    
    query += ` ORDER BY rl.receipt_date DESC, rl.id DESC`;
    
    console.log('[DEBUG] Query:', query);
    console.log('[DEBUG] Params:', params);
    
    db.all(query, params, (err, rows) => {
        if (err) {
            console.error('[ERROR] Database error:', err);
            db.close();
            return res.status(500).json({ error: 'Database error' });
        }
        
        console.log('[DEBUG] Remittance records found:', rows.length);
        db.close();
        res.json(rows);
    });
}

function apiCustomerBalances(req, res) {
    if (!req.session.role || (req.session.role !== 'admin' && req.session.role !== 'worker')) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const db = getDbConnection();

    // H3/H4: non-admin users may only see balances of customers they own.
    const ownedScope = req.session.role === 'admin'
        ? ''
        : ' WHERE customer_id IN (SELECT id FROM customers WHERE LOWER(created_by) = LOWER(?))';
    const ownedScopeParams = ownedScope ? [req.session.username] : [];

    db.all('SELECT customer_id, SUM(net_cement_money) as total_debit FROM sales_logs' + ownedScope + ' GROUP BY customer_id', ownedScopeParams, (err, salesSums) => {
        if (err) {
            db.close();
            return res.status(500).json({ error: 'Database error' });
        }
        
        db.all('SELECT customer_id, SUM(amount_received) as total_credit FROM receipts_logs' + ownedScope + ' GROUP BY customer_id', ownedScopeParams, (err, receiptSums) => {
            if (err) {
                db.close();
                return res.status(500).json({ error: 'Database error' });
            }
            
            const debits = {};
            const credits = {};
            
            salesSums.forEach(row => {
                debits[row.customer_id] = row.total_debit;
            });
            
            receiptSums.forEach(row => {
                credits[row.customer_id] = row.total_credit;
            });
            
            const balances = [];
            const allCustIds = new Set([...Object.keys(debits), ...Object.keys(credits)]);
            
            allCustIds.forEach(cId => {
                const netBalance = (debits[cId] || 0.0) - (credits[cId] || 0.0);
                balances.push({
                    customer_id: cId,
                    net_balance: netBalance
                });
            });
            
            db.close();
            res.json({ balances });
        });
    });
}

function apiUpdateAgentLogRow(req, res) {
    console.log('[DEBUG] apiUpdateAgentLogRow called - Session role:', req.session.role);
    
    if (!req.session.role || req.session.role !== 'admin') {
        console.error('[ERROR] Unauthorized access attempt');
        return res.status(403).json({ error: 'Unauthorized - Admin access required' });
    }
    
    const recordId = req.params.id;
    const {
        sale_date,
        customer_id,
        driver_name,
        car_plate,
        waybill_number,
        cement_type,
        bags_count,
        tonnage,
        shortage,
        unit_price_bag,
        total_sales_money,
        freight_per_ton,
        total_freight,
        net_cement_money,
        province_origin
    } = req.body;
    
    console.log('[DEBUG] Updating record:', recordId, 'with data:', req.body);
    
    const db = getDbConnection();
    
    const updateQuery = `
        UPDATE sales_logs SET
            sale_date = ?,
            customer_id = ?,
            driver_name = ?,
            car_plate = ?,
            waybill_number = ?,
            cement_type = ?,
            bags_count = ?,
            tonnage = ?,
            shortage = ?,
            unit_price_bag = ?,
            total_sales_money = ?,
            freight_per_ton = ?,
            total_freight = ?,
            net_cement_money = ?,
            province_origin = ?
        WHERE id = ?
    `;
    
    const params = [
        sale_date,
        customer_id,
        driver_name,
        car_plate,
        waybill_number,
        cement_type,
        bags_count,
        tonnage,
        shortage,
        unit_price_bag,
        total_sales_money,
        freight_per_ton,
        total_freight,
        net_cement_money,
        province_origin,
        recordId
    ];
    
    db.run(updateQuery, params, function(err) {
        if (err) {
            console.error('[ERROR] Error updating agent log row:', err);
            db.close();
            return res.status(500).json({ error: 'Database error', details: 'Internal error' });
        }
        
        console.log('[DEBUG] Record updated successfully, changes:', this.changes);
        db.close();
        res.json({ success: true, message: 'Record updated successfully' });
    });
}

function apiDeleteAgentLogRow(req, res) {
    console.log('[DEBUG] apiDeleteAgentLogRow called - Session role:', req.session.role);
    
    if (!req.session.role || req.session.role !== 'admin') {
        console.error('[ERROR] Unauthorized access attempt');
        return res.status(403).json({ error: 'Unauthorized - Admin access required' });
    }
    
    const recordId = req.params.id;
    console.log('[DEBUG] Deleting record:', recordId);
    
    const db = getDbConnection();
    
    db.run('DELETE FROM sales_logs WHERE id = ?', [recordId], function(err) {
        if (err) {
            console.error('[ERROR] Error deleting agent log row:', err);
            db.close();
            return res.status(500).json({ error: 'Database error', details: 'Internal error' });
        }
        
        console.log('[DEBUG] Record deleted successfully, changes:', this.changes);
        db.close();
        res.json({ success: true, message: 'Record deleted successfully' });
    });
}

function apiCustomerFinancialSummary(req, res) {
    if (!req.session.role || req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized - Admin access required' });
    }

    const db = getDbConnection();

    // Get optional filters
    const startDate = req.query.start_date || '';
    const endDate = req.query.end_date || '';
    const searchCustomer = req.query.search_customer || '';
    const balanceFilter = req.query.balance || 'All';
    const provinceFilter = req.query.province || 'All';
    const agencyFilter = req.query.agency || 'All';

    // Build base query for customers with user info
    let query = `
        SELECT
            c.id as customer_id,
            c.customer_id as customer_customer_id,
            c.name as customer_name,
            c.province as customer_province,
            c.created_by as customer_created_by,
            c.created_by_agency as customer_created_by_agency,
            u.agency_name as user_agency_name
        FROM customers c
        LEFT JOIN users u ON c.created_by = u.username
        WHERE 1=1
    `;

    const params = [];

    // Apply customer search (partial match)
    if (searchCustomer) {
        query += ` AND (c.name LIKE ? ESCAPE '\\' OR c.customer_id LIKE ? ESCAPE '\\')`;
        params.push(likeContains(searchCustomer), likeContains(searchCustomer));
    }

    // Apply province filter (customer's own province)
    if (provinceFilter !== 'All') {
        query += ` AND c.province = ?`;
        params.push(provinceFilter);
    }

    // Apply agency filter (who registered the customer)
    if (agencyFilter !== 'All') {
        query += ` AND (u.agency_name = ? OR c.created_by_agency = ? OR c.created_by = ?)`;
        params.push(agencyFilter, agencyFilter, agencyFilter);
    }

    query += ` ORDER BY c.name ASC`;

    db.all(query, params, (err, customers) => {
        if (err) {
            console.error('[ERROR] Error fetching customers:', err);
            db.close();
            return res.status(500).json({ error: 'Database error' });
        }

        // Fetch financial data for each customer using separate queries (same as Customer Detail modal)
        // This avoids JOIN multiplication bug
        const summaryData = customers.map(customer => {
            let totalDebit = 0;
            let totalCredit = 0;
            let totalTransfers = 0;
            let bankTransfers = 0;
            let sarafiTransfers = 0;

            // Build date filter for sales
            let salesQuery = `SELECT SUM(net_cement_money) as total_debit FROM sales_logs WHERE customer_id = ?`;
            let salesParams = [customer.customer_id];
            if (startDate) {
                salesQuery += ` AND sale_date >= ?`;
                salesParams.push(startDate);
            }
            if (endDate) {
                salesQuery += ` AND sale_date <= ?`;
                salesParams.push(endDate);
            }

            // Build date filter for receipts
            let receiptsQuery = `SELECT SUM(amount_received) as total_credit, COUNT(*) as count, 
                SUM(CASE WHEN origin_source = 'Bank' THEN 1 ELSE 0 END) as bank_count,
                SUM(CASE WHEN origin_source = 'Sarafi' THEN 1 ELSE 0 END) as sarafi_count
                FROM receipts_logs WHERE customer_id = ?`;
            let receiptsParams = [customer.customer_id];
            if (startDate) {
                receiptsQuery += ` AND receipt_date >= ?`;
                receiptsParams.push(startDate);
            }
            if (endDate) {
                receiptsQuery += ` AND receipt_date <= ?`;
                receiptsParams.push(endDate);
            }

            return new Promise((resolve) => {
                db.get(salesQuery, salesParams, (err, salesResult) => {
                    if (err) {
                        console.error('[ERROR] Error fetching sales data:', err);
                        resolve(null);
                        return;
                    }
                    totalDebit = salesResult.total_debit || 0;

                    db.get(receiptsQuery, receiptsParams, (err, receiptsResult) => {
                        if (err) {
                            console.error('[ERROR] Error fetching receipts data:', err);
                            resolve(null);
                            return;
                        }
                        totalCredit = receiptsResult.total_credit || 0;
                        totalTransfers = receiptsResult.count || 0;
                        bankTransfers = receiptsResult.bank_count || 0;
                        sarafiTransfers = receiptsResult.sarafi_count || 0;

                        const companyOwesCustomer = totalCredit - totalDebit;
                        const customerOwesCompany = totalDebit - totalCredit;

                        resolve({
                            customer_id: customer.customer_id,
                            customer_customer_id: customer.customer_customer_id,
                            customer_name: customer.customer_name,
                            customer_province: customer.customer_province,
                            registered_agency: customer.user_agency_name || customer.customer_created_by_agency || customer.customer_created_by || '-',
                            total_cement_purchase_value: totalDebit,
                            total_money_transferred: totalCredit,
                            company_owes_customer: companyOwesCustomer > 0 ? companyOwesCustomer : 0,
                            customer_owes_company: customerOwesCompany > 0 ? customerOwesCompany : 0,
                            total_transfers: totalTransfers,
                            bank_transfers: bankTransfers,
                            sarafi_transfers: sarafiTransfers
                        });
                    });
                });
            });
        });

        Promise.all(summaryData).then(results => {
            const validResults = results.filter(r => r !== null);

            // Apply balance filter on the results
            let filteredData = validResults;
            if (balanceFilter !== 'All') {
                filteredData = validResults.filter(row => {
                    const netBalance = row.customer_owes_company - row.company_owes_customer;
                    if (balanceFilter === 'customer_owes') return row.customer_owes_company > 0.1;
                    if (balanceFilter === 'company_owes') return row.company_owes_customer > 0.1;
                    if (balanceFilter === 'zero') return Math.abs(netBalance) <= 0.1;
                    return true;
                });
            }

            db.close();
            res.json({ customers: filteredData });
        }).catch(err => {
            console.error('[ERROR] Error processing customer financial summary:', err);
            db.close();
            res.status(500).json({ error: 'Database error' });
        });
    });
}

module.exports = {
    apiDailySalesReport,
    apiCustomerDetails,
    apiAgentLogSubmissions,
    apiRemittanceLedger,
    apiCustomerBalances,
    apiUpdateAgentLogRow,
    apiDeleteAgentLogRow,
    apiCustomerFinancialSummary
};
