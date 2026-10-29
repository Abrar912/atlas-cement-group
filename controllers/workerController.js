const { getDbConnection, PROVINCE_CODES } = require('../config/database');
const { likeContains } = require('../utils/sqlSafety');
const notificationSSE = require('../utils/notificationSSE');

// Helper function to clean customer_id - extract only the code part (e.g., KAB-001)
function cleanCustomerId(rawId) {
    if (!rawId) return '';
    // Extract prefix and number matching pattern like KAB-001 or KAB-002
    const match = rawId.match(/^([A-Z]{3}-\d+)/i);
    return match ? match[1].toUpperCase() : rawId;
}

function workerSalesView(req, res) {
    const db = getDbConnection();
    
    // Worker ownership: workers only see customers they registered
    db.all('SELECT * FROM customers WHERE LOWER(created_by) = LOWER(?) ORDER BY name ASC', [req.session.username], (err, customers) => {
        db.close();
        if (err) {
            return res.status(500).send('Database error');
        }
        res.render('worker_view', { customers });
    });
}

function workerAddSalesBatch(req, res) {
    if (req.session.role !== 'worker') {
        return res.status(403).json({ success: false, message: 'Unauthorized entry' });
    }
    
    const batch = req.body.batch || [];
    
    if (!batch || batch.length === 0) {
        return res.status(400).json({ success: false, message: 'Empty data batch' });
    }
    
    const db = getDbConnection();
    
    db.serialize(() => {
        let completed = 0;
        let hasError = false;
        
        db.run('BEGIN TRANSACTION', (beginErr) => {
            if (beginErr) {
                hasError = true;
                db.close();
                return res.status(500).json({ success: false, message: beginErr.message });
            }

            batch.forEach((item, index) => {
                const bags = parseInt(item.bags_count);
                const shortage = parseInt(item.shortage) || 0;
                const soldBags = bags - shortage;
                const computedTonnage = bags / 20.0;
                const totalSales = soldBags * parseFloat(item.unit_price_bag);
                
                let freightPerTon = null;
                let totalFreight = 0.0;
                let netCement = totalSales;
                
                const isCompanyCar = parseInt(item.is_company_car) === 1;
                
                if (!isCompanyCar) {
                    freightPerTon = parseFloat(item.freight_per_ton);
                    totalFreight = computedTonnage * freightPerTon;
                    netCement = totalSales - totalFreight;
                }
                
                db.run(`
                    INSERT INTO sales_logs (
                        sale_date, customer_id, driver_name, car_plate, waybill_number, 
                        cement_type, bags_count, tonnage, shortage, unit_price_bag, 
                        total_sales_money, freight_per_ton, total_freight, is_company_car, 
                        net_cement_money, province_origin, user_id, is_posted
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                `, [
                    item.sale_date,
                    item.customer_id,
                    item.driver_name,
                    item.car_plate,
                    item.waybill_number,
                    item.cement_type,
                    bags,
                    computedTonnage,
                    parseInt(item.shortage || 0),
                    parseFloat(item.unit_price_bag),
                    totalSales,
                    freightPerTon,
                    totalFreight,
                    isCompanyCar ? 1 : 0,
                    netCement,
                    req.session.province || 'Kabul',
                    req.session.user_id
                ], (err) => {
                    if (err) {
                        if (hasError) {
                            return;
                        }
                        hasError = true;
                        db.run('ROLLBACK', () => {
                            db.close();
                            return res.status(500).json({ success: false, message: err.message });
                        });
                        return;
                    }
                    
                    if (hasError) {
                        return;
                    }
                    completed++;
                    if (completed === batch.length && !hasError) {
                        db.run('COMMIT', (commitErr) => {
                            if (commitErr) {
                                db.run('ROLLBACK', () => {
                                    db.close();
                                    return res.status(500).json({ success: false, message: commitErr.message });
                                });
                                return;
                            }

                            // Create admin notification for sales report
                            const agencyName = req.session.agency_name || req.session.username;
                            const waybillNumber = batch[0].waybill_number || 'ناشناخته';
                            const notificationMessage = `گزارش بارنامه شماره ${waybillNumber} از نمایندگی ${agencyName} دریافت شد`;
                            
                            db.run(`
                                INSERT INTO admin_notifications (type, message, related_record_type, related_record_id, agency_name, created_by, recipient)
                                VALUES (?, ?, ?, ?, ?, ?, ?)
                            `, ['agency_report_received', notificationMessage, 'sales_report', null, agencyName, req.session.username, 'admin'], function(notifErr) {
                                if (notifErr) {
                                    console.error('Error creating admin notification:', notifErr);
                                } else {
                                    // Broadcast the admin notification via SSE
                                    const adminNotification = {
                                        id: this.lastID,
                                        type: 'agency_report_received',
                                        message: notificationMessage,
                                        related_record_id: null,
                                        related_record_type: 'sales_report',
                                        agency_name: agencyName,
                                        created_by: req.session.username,
                                        recipient: 'admin',
                                        is_read: 0,
                                        created_at: new Date().toISOString()
                                    };
                                    notificationSSE.broadcast(adminNotification);
                                }
                                
                                // Create worker notification for sales report sent (Worker Event 2)
                                const workerUsername = req.session.username;
                                const customerName = batch[0].customer_id || 'ناشناخته';
                                const workerNotificationMessage = `گزارش بارنامه شماره ${waybillNumber} مربوط به مشتری ${customerName} با موفقیت به اداره مرکزی ارسال شد`;
                                
                                db.run(`
                                    INSERT INTO admin_notifications (type, message, related_record_id, related_record_type, created_by, recipient, is_read, created_at)
                                    VALUES (?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
                                `, ['worker_sales_report_sent', workerNotificationMessage, null, 'sales_report', req.session.username, workerUsername], function(workerNotifErr) {
                                    if (workerNotifErr) {
                                        console.error('[ERROR] Error creating worker sales report sent notification:', workerNotifErr);
                                    } else {
                                        console.log('[DEBUG] Worker sales report sent notification created for:', workerUsername);
                                        
                                        // Broadcast the worker notification via SSE
                                        const workerNotification = {
                                            id: this.lastID,
                                            type: 'worker_sales_report_sent',
                                            message: workerNotificationMessage,
                                            related_record_id: null,
                                            related_record_type: 'sales_report',
                                            created_by: req.session.username,
                                            recipient: workerUsername,
                                            is_read: 0,
                                            created_at: new Date().toISOString()
                                        };
                                        notificationSSE.broadcast(workerNotification);
                                    }
                                    db.close();
                                    res.json({ success: true, message: 'Batch safely committed to primary ledgers' });
                                });
                            });
                        });
                    }
                });
            });
        });
    });
}

function workerReceiptsView(req, res) {
    const db = getDbConnection();
    const sessionUser = (req.session.username || '').trim().toLowerCase();
    
    if (req.session.role === 'admin') {
        db.all("SELECT * FROM customers ORDER BY name ASC", [], (err, rows) => {
            db.close();
            if (err) {
                console.error("Error fetching customers (admin):", err);
                return res.status(500).send('Database error');
            }
            console.log(`[DEBUG] Admin loaded ${rows.length} customers.`);
            res.render('worker_receipts', { session: req.session, customers: rows || [] });
        });
    } else {
        // H3/H4: workers see exactly the customers they registered — same
        // predicate as the manage-customers list. The old province/agency
        // OR-query leaked other workers' customers via substring matching.
        const query = 'SELECT * FROM customers WHERE LOWER(created_by) = LOWER(?) ORDER BY name ASC';
        db.all(query, [sessionUser], (err, rows) => {
            db.close();
            if (err) {
                console.error("Error fetching customers (worker):", err);
                return res.status(500).send('Database error');
            }
            console.log(`[DEBUG] Agent '${sessionUser}' loaded ${rows.length} customers.`);
            res.render('worker_receipts', { session: req.session, customers: rows || [] });
        });
    }
}

function workerAddReceiptsBatch(req, res) {
    if (req.session.role !== 'worker') {
        return res.status(403).json({ success: false });
    }
    
    const batch = req.body.batch || [];
    
    const db = getDbConnection();
    
    db.serialize(() => {
        let completed = 0;
        let hasError = false;
        
        batch.forEach((item) => {
            // Auto-populate receiving_station from user's session province
            const receivingStation = req.session.province || req.session.assigned_province || 'Kabul';
            
            // Combine origin_source_type and origin_source_name into single origin_source field for display
            const originSource = item.origin_source_type && item.origin_source_name
                ? `${item.origin_source_type} - ${item.origin_source_name}`
                : (item.origin_source_type || item.origin_source_name || 'Unknown');
            
            // Save origin_source_type separately for filtering
            const originSourceType = item.origin_source_type || 'Unknown';
            
            db.run(`
                INSERT INTO receipts_logs (
                    receipt_date, customer_id, sender_name, origin_source, origin_source_type,
                    remittance_number, receiving_station, amount_received, user_id, is_posted
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
            `, [
                item.receipt_date,
                item.customer_id,
                item.sender_name,
                originSource,
                originSourceType,
                item.remittance_number,
                receivingStation,
                parseFloat(item.amount_received),
                req.session.user_id
            ], (err) => {
                if (err) {
                    hasError = true;
                    db.close();
                    return res.status(500).json({ success: false, message: 'Batch save failed' });
                }
                
                completed++;
                if (completed === batch.length && !hasError) {
                    // Create admin notification for remittance
                    const agencyName = req.session.agency_name || req.session.username;
                    const totalAmount = batch.reduce((sum, item) => sum + (parseFloat(item.amount_received) || 0), 0);
                    const notificationMessage = `مبلغ ${totalAmount.toLocaleString()} افغانی توسط نمایندگی ${agencyName} ارسال شد`;
                    
                    db.run(`
                        INSERT INTO admin_notifications (type, message, related_record_type, related_record_id, agency_name, created_by, recipient)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                    `, ['agency_remittance_received', notificationMessage, 'remittance', null, agencyName, req.session.username, 'admin'], (notifErr) => {
                        if (notifErr) {
                            console.error('Error creating notification:', notifErr);
                        }
                        db.close();
                        res.json({ success: true });
                    });
                }
            });
        });
    });
}

function workerManageCustomers(req, res) {
    const db = getDbConnection();
    const userProvince = req.session.province || 'Kabul';
    
    if (req.method === 'POST') {
        const { name, customer_type, organization_name, contact_person_position, province, phone, alternative_phone, email, address } = req.body;
        
        // Sanitize inputs - trim whitespace from name
        const sanitizedName = name ? name.trim() : '';
        
        if (!sanitizedName) {
            db.close();
            req.session.message = { type: 'error', text: 'Error: Customer name cannot be empty.' };
            return res.redirect('/worker/manage-customers');
        }

        // Validate phone number format (E164 international format)
        if (phone) {
            const cleanPhone = phone.trim();
            // Check if it starts with + and contains only digits after that
            if (!cleanPhone.match(/^\+\d{8,15}$/)) {
                db.close();
                req.session.message = { type: 'error', text: 'Error: Invalid phone number format. Please use international format (e.g., +93701234567).' };
                return res.redirect('/worker/manage-customers');
            }
            // Reject +930 prefix (invalid Afghan format - should be +93 without leading 0)
            if (cleanPhone.startsWith('+930')) {
                db.close();
                req.session.message = { type: 'error', text: 'Error: Invalid Afghan phone format. Use +93XXXXXXXXX (without leading 0 after +93).' };
                return res.redirect('/worker/manage-customers');
            }
        }
        
        // Generate province-prefixed customer ID based on CREATING AGENCY's province (session.province)
        // NOT the customer's delivery province - this ensures agency-based ownership
        const agencyProvince = req.session.province || 'Kabul';
        const provinceCode = PROVINCE_CODES[agencyProvince] || agencyProvince.substring(0, 3).toUpperCase();
        
        // Debug logging to verify agency-based province code generation
        console.log(`Generating customer ID for agency province: ${agencyProvince}, provinceCode: ${provinceCode}`);
        console.log(`Customer delivery province: ${province} (used for address only, not ID prefix)`);
        
        // Get next serial number for this AGENCY province
        db.get('SELECT next_serial FROM province_serial_counters WHERE province = ?', [agencyProvince], (err, row) => {
            if (err) {
                db.close();
                req.session.message = { type: 'error', text: 'Database error generating customer ID.' };
                return res.redirect('/worker/manage-customers');
            }
            
            const nextSerial = row ? row.next_serial : 1;
            const serialStr = String(nextSerial).padStart(3, '0');
            const customerId = `${provinceCode}-${serialStr}`;
            
            // Debug logging to verify final customer ID
            console.log(`Generated customer_id: ${customerId}`);
            
            // Insert customer with generated ID and ownership tracking
            // created_by stores the username of the worker who registered the customer
            // created_by_agency is retained for historical/business information
            // Optional fields can be null/empty
            db.run('INSERT INTO customers (customer_id, name, customer_type, organization_name, contact_person_position, province, phone, alternative_phone, email, address, created_by, created_by_agency) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [customerId, sanitizedName, customer_type || null, organization_name || null, contact_person_position || null, province, phone || null, alternative_phone || null, email || null, address || null, req.session.username, agencyProvince], function(err) {
                if (err) {
                    if (err.message.includes('UNIQUE')) {
                        req.session.message = { type: 'error', text: 'Error: A customer with this name already exists in ' + agencyProvince + ' agency.' };
                    } else {
                        req.session.message = { type: 'error', text: 'Error: Unable to save customer' };
                    }
                } else {
                    const newCustomerId = this.lastID;
                    
                    // Update serial counter for this AGENCY province
                    db.run('INSERT OR REPLACE INTO province_serial_counters (province, next_serial) VALUES (?, ?)',
                        [agencyProvince, nextSerial + 1], (err) => {
                            if (err) {
                                console.error('Error updating serial counter:', err);
                            }
                        });
                    req.session.message = { type: 'success', text: 'Customer added to registry files successfully!' };
                    
                    // Create worker notification for customer created
                    const workerUsername = req.session.username;
                    const notificationMessage = `مشتری جدید "${sanitizedName}" توسط شما ایجاد شد`;
                    
                    db.run(`
                        INSERT INTO admin_notifications (type, message, related_record_id, related_record_type, created_by, recipient, is_read, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
                    `, ['worker_customer_created', notificationMessage, newCustomerId, 'customer', req.session.username, workerUsername], function(notifErr) {
                        if (notifErr) {
                            console.error('[ERROR] Error creating worker customer created notification:', notifErr);
                        } else {
                            console.log('[DEBUG] Worker customer created notification created for:', workerUsername);
                            
                            // Broadcast the worker notification via SSE
                            const workerNotification = {
                                id: this.lastID,
                                type: 'worker_customer_created',
                                message: notificationMessage,
                                related_record_id: newCustomerId,
                                related_record_type: 'customer',
                                created_by: req.session.username,
                                recipient: workerUsername,
                                is_read: 0,
                                created_at: new Date().toISOString()
                            };
                            notificationSSE.broadcast(workerNotification);
                        }
                    });
                }
                
                // Worker ownership: workers only see customers they registered
                db.all('SELECT * FROM customers WHERE LOWER(created_by) = LOWER(?) ORDER BY id DESC', [req.session.username], (err, customers) => {
                    db.close();
                    const message = req.session.message;
                    req.session.message = null;
                    res.render('worker_customers', { customers, message });
                });
            });
        });
    } else {
        // Worker ownership: workers only see customers they registered
        db.all('SELECT * FROM customers WHERE LOWER(created_by) = LOWER(?) ORDER BY id DESC', [req.session.username], (err, customers) => {
            db.close();
            const message = req.session.message;
            req.session.message = null;
            res.render('worker_customers', { customers, message });
        });
    }
}

function workerDeleteCustomer(req, res) {
    const { id } = req.params;
    const userProvince = req.session.province || 'Kabul';
    const db = getDbConnection();
    
    // Worker ownership: workers can only delete customers they registered
    db.run('DELETE FROM customers WHERE id = ? AND LOWER(created_by) = LOWER(?)', [id, req.session.username], (err) => {
        db.close();
        if (err) {
            req.session.message = { type: 'error', text: 'Error deleting customer.' };
        } else {
            req.session.message = { type: 'success', text: 'Customer file purged from current directory.' };
        }
        res.redirect('/worker/manage-customers');
    });
}

function workerEditCustomer(req, res) {
    const { id } = req.params;
    const { name, customer_type, organization_name, contact_person_position, province, phone, alternative_phone, email, address } = req.body;
    const userProvince = req.session.province || 'Kabul';
    const db = getDbConnection();
    
    // Sanitize inputs - trim whitespace from name
    const sanitizedName = name ? name.trim() : '';
    
    if (!sanitizedName) {
        db.close();
        req.session.message = { type: 'error', text: 'Error: Customer name cannot be empty.' };
        return res.redirect('/worker/manage-customers');
    }

    // Validate phone number format (E164 international format)
    if (phone) {
        const cleanPhone = phone.trim();
        // Check if it starts with + and contains only digits after that
        if (!cleanPhone.match(/^\+\d{8,15}$/)) {
            db.close();
            req.session.message = { type: 'error', text: 'Error: Invalid phone number format. Please use international format (e.g., +93701234567).' };
            return res.redirect('/worker/manage-customers');
        }
        // Reject +930 prefix (invalid Afghan format - should be +93 without leading 0)
        if (cleanPhone.startsWith('+930')) {
            db.close();
            req.session.message = { type: 'error', text: 'Error: Invalid Afghan phone format. Use +93XXXXXXXXX (without leading 0 after +93).' };
            return res.redirect('/worker/manage-customers');
        }
    }
    
    // Worker ownership: workers can only edit customers they registered
    // Optional fields can be null/empty
    db.run('UPDATE customers SET name = ?, customer_type = ?, organization_name = ?, contact_person_position = ?, province = ?, phone = ?, alternative_phone = ?, email = ?, address = ? WHERE id = ? AND LOWER(created_by) = LOWER(?)',
        [sanitizedName, customer_type || null, organization_name || null, contact_person_position || null, province, phone || null, alternative_phone || null, email || null, address || null, id, req.session.username], (err) => {
        if (err) {
            if (err.message.includes('UNIQUE')) {
                req.session.message = { type: 'error', text: 'Error: A customer with this name already exists in ' + province + ' province.' };
            } else {
                req.session.message = { type: 'error', text: 'Error: Unable to save customer' };
            }
        } else {
            req.session.message = { type: 'success', text: 'Customer account updated successfully!' };
            
            // Create worker notification for customer updated
            const workerUsername = req.session.username;
            const notificationMessage = `اطلاعات مشتری "${sanitizedName}" توسط شما ویرایش شد`;
            
            db.run(`
                INSERT INTO admin_notifications (type, message, related_record_id, related_record_type, created_by, recipient, is_read, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
            `, ['worker_customer_updated', notificationMessage, id, 'customer', req.session.username, workerUsername], function(notifErr) {
                if (notifErr) {
                    console.error('[ERROR] Error creating worker customer updated notification:', notifErr);
                } else {
                    console.log('[DEBUG] Worker customer updated notification created for:', workerUsername);
                    
                    // Broadcast the worker notification via SSE
                    const workerNotification = {
                        id: this.lastID,
                        type: 'worker_customer_updated',
                        message: notificationMessage,
                        related_record_id: id,
                        related_record_type: 'customer',
                        created_by: req.session.username,
                        recipient: workerUsername,
                        is_read: 0,
                        created_at: new Date().toISOString()
                    };
                    notificationSSE.broadcast(workerNotification);
                }
            });
        }
        
        // Worker ownership: workers only see customers they registered
        db.all('SELECT * FROM customers WHERE LOWER(created_by) = LOWER(?) ORDER BY id DESC', [req.session.username], (err, customers) => {
            db.close();
            const message = req.session.message;
            req.session.message = null;
            res.render('worker_customers', { customers, message });
        });
    });
}

function workerCreateWaybill(req, res) {
    res.render('worker_waybill');
}

function apiAgencyCustomers(req, res) {
    if (!req.session.role || (req.session.role !== 'worker' && req.session.role !== 'admin')) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const db = getDbConnection();
    
    // Get search parameters from query string
    const { customer_id, customer_name, province, phone, address } = req.query;
    
    // Build the base query with worker ownership restriction
    let query = "SELECT * FROM customers WHERE LOWER(created_by) = LOWER(?)";
    const params = [req.session.username];
    
    // Add search filters if provided
    if (customer_id && customer_id.trim()) {
        query += " AND customer_id LIKE ? ESCAPE '\\'";
        params.push(likeContains(customer_id.trim()));
    }
    
    if (customer_name && customer_name.trim()) {
        query += " AND name LIKE ? ESCAPE '\\'";
        params.push(likeContains(customer_name.trim()));
    }
    
    if (province && province !== 'All') {
        query += " AND province = ?";
        params.push(province);
    }
    
    if (phone && phone.trim()) {
        query += " AND phone LIKE ? ESCAPE '\\'";
        params.push(likeContains(phone.trim()));
    }
    
    if (address && address.trim()) {
        query += " AND address LIKE ? ESCAPE '\\'";
        params.push(likeContains(address.trim()));
    }
    
    query += " ORDER BY name ASC";
    
    db.all(query, params, (err, rows) => {
        db.close();
        if (err) {
            console.error("Error fetching customers (worker search) via API:", err);
            return res.status(500).json({ error: 'Database error' });
        }
        console.log(`[DEBUG] Worker '${req.session.username}' search returned ${rows.length} customers.`);
        res.json({ customers: rows });
    });
}

function workerCommandDeck(req, res) {
    const db = getDbConnection();
    
    // Get customers registered by this worker for the dropdown
    db.all('SELECT * FROM customers WHERE LOWER(created_by) = LOWER(?) ORDER BY name ASC', [req.session.username], (err, customers) => {
        if (err) {
            db.close();
            return res.status(500).send('Database error');
        }
        
        const agencyCustomerIds = new Set(customers.map(c => c.id));
        
        // Calculate financial metrics for this agency only
        db.all('SELECT customer_id, SUM(net_cement_money) as total_debit FROM sales_logs GROUP BY customer_id', (err, salesSums) => {
            if (err) {
                db.close();
                return res.status(500).send('Database error');
            }
            
            db.all('SELECT customer_id, SUM(amount_received) as total_credit FROM receipts_logs GROUP BY customer_id', (err, receiptSums) => {
                if (err) {
                    db.close();
                    return res.status(500).send('Database error');
                }
                
                // Calculate total sales and total received for this agency
                db.all('SELECT SUM(net_cement_money) as total_sales FROM sales_logs WHERE customer_id IN (SELECT id FROM customers WHERE LOWER(created_by) = LOWER(?))', [req.session.username], (err, totalSalesResult) => {
                    if (err) {
                        db.close();
                        return res.status(500).send('Database error');
                    }
                    
                    db.all('SELECT SUM(amount_received) as total_received FROM receipts_logs WHERE customer_id IN (SELECT id FROM customers WHERE LOWER(created_by) = LOWER(?))', [req.session.username], (err, totalReceivedResult) => {
                        if (err) {
                            db.close();
                            return res.status(500).send('Database error');
                        }
                        
                        const debits = {};
                        const credits = {};
                        
                        salesSums.forEach(row => {
                            if (agencyCustomerIds.has(row.customer_id)) {
                                debits[row.customer_id] = row.total_debit;
                            }
                        });
                        
                        receiptSums.forEach(row => {
                            if (agencyCustomerIds.has(row.customer_id)) {
                                credits[row.customer_id] = row.total_credit;
                            }
                        });
                        
                        let totalReceivables = 0.0;
                        let totalPayables = 0.0;
                        
                        const allCustIds = new Set([...Object.keys(debits), ...Object.keys(credits)]);
                        allCustIds.forEach(cId => {
                            const bal = (debits[cId] || 0.0) - (credits[cId] || 0.0);
                            if (bal > 0) {
                                totalReceivables += bal;
                            } else if (bal < 0) {
                                totalPayables += Math.abs(bal);
                            }
                        });
                        
                        const totalSalesMoney = totalSalesResult[0]?.total_sales || 0;
                        const totalMoneyReceived = totalReceivedResult[0]?.total_received || 0;
                        
                        db.close();
                        res.render('worker_command_deck', {
                            total_receivables: totalReceivables,
                            total_payables: totalPayables,
                            total_sales_money: totalSalesMoney,
                            total_money_received: totalMoneyReceived,
                            user_agency: req.session.username,
                            customers: customers,
                            provinces: Object.keys(PROVINCE_CODES)
                        });
                    });
                });
            });
        });
    });
}

function apiWorkerFinancialMetrics(req, res) {
    if (!req.session.role || req.session.role !== 'worker') {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const db = getDbConnection();
    
    // Get customers registered by this worker
    db.all('SELECT id FROM customers WHERE LOWER(created_by) = LOWER(?)', [req.session.username], (err, agencyCustomers) => {
        if (err) {
            db.close();
            return res.status(500).json({ error: 'Database error' });
        }
        
        const agencyCustomerIds = new Set(agencyCustomers.map(c => c.id));
        
        db.all('SELECT customer_id, SUM(net_cement_money) as total_debit FROM sales_logs GROUP BY customer_id', (err, salesSums) => {
            if (err) {
                db.close();
                return res.status(500).json({ error: 'Database error' });
            }
            
            db.all('SELECT customer_id, SUM(amount_received) as total_credit FROM receipts_logs GROUP BY customer_id', (err, receiptSums) => {
                if (err) {
                    db.close();
                    return res.status(500).json({ error: 'Database error' });
                }
                
                // Calculate total sales and total received for this agency
                db.all('SELECT SUM(net_cement_money) as total_sales FROM sales_logs WHERE customer_id IN (SELECT id FROM customers WHERE LOWER(created_by) = LOWER(?))', [req.session.username], (err, totalSalesResult) => {
                    if (err) {
                        db.close();
                        return res.status(500).json({ error: 'Database error' });
                    }
                    
                    db.all('SELECT SUM(amount_received) as total_received FROM receipts_logs WHERE customer_id IN (SELECT id FROM customers WHERE LOWER(created_by) = LOWER(?))', [req.session.username], (err, totalReceivedResult) => {
                        if (err) {
                            db.close();
                            return res.status(500).json({ error: 'Database error' });
                        }
                        
                        const debits = {};
                        const credits = {};
                        
                        salesSums.forEach(row => {
                            if (agencyCustomerIds.has(row.customer_id)) {
                                debits[row.customer_id] = row.total_debit;
                            }
                        });
                        
                        receiptSums.forEach(row => {
                            if (agencyCustomerIds.has(row.customer_id)) {
                                credits[row.customer_id] = row.total_credit;
                            }
                        });
                        
                        let totalReceivables = 0.0;
                        let totalPayables = 0.0;
                        
                        const allCustIds = new Set([...Object.keys(debits), ...Object.keys(credits)]);
                        allCustIds.forEach(cId => {
                            const bal = (debits[cId] || 0.0) - (credits[cId] || 0.0);
                            if (bal > 0) {
                                totalReceivables += bal;
                            } else if (bal < 0) {
                                totalPayables += Math.abs(bal);
                            }
                        });
                        
                        const totalSalesMoney = totalSalesResult[0]?.total_sales || 0;
                        const totalMoneyReceived = totalReceivedResult[0]?.total_received || 0;
                        
                        db.close();
                        res.json({
                            total_receivables: totalReceivables,
                            total_payables: totalPayables,
                            total_sales_money: totalSalesMoney,
                            total_money_received: totalMoneyReceived
                        });
                    });
                });
            });
        });
    });
}

function apiWorkerAgentLogSubmissions(req, res) {
    if (!req.session.role || req.session.role !== 'worker') {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const userAgency = req.session.province || req.session.assigned_province || 'Kabul';
    const db = getDbConnection();
    
    // Get filter parameters
    const province = req.query.province || 'All';
    const balance = req.query.balance || 'All';
    const customerId = req.query.customer_id || 'All';
    const cement = req.query.cement || 'All';
    const truck = req.query.truck || 'All';
    const startDate = req.query.start_date || '';
    const endDate = req.query.end_date || '';
    const searchDriver = req.query.search_driver || '';
    const searchWaybill = req.query.search_waybill || '';
    
    // Build base query with strict agency filter
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
            lw.truck_type,
            u.username as submitted_by
        FROM sales_logs sl
        LEFT JOIN customers c ON sl.customer_id = c.id
        LEFT JOIN users u ON sl.user_id = u.id
        LEFT JOIN local_waybills lw ON sl.waybill_number = lw.waybill_serial
        WHERE LOWER(c.created_by) = LOWER(?)
    `;
    
    const params = [req.session.username];
    
    // Apply additional filters
    if (province !== 'All') {
        query += ` AND c.province = ?`;
        params.push(province);
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
        query += ` AND lw.truck_type = ?`;
        params.push(truck.toLowerCase());
    }
    
    if (startDate) {
        const normalizedStartDate = startDate.replace(/-/g, '/');
        query += ` AND sl.sale_date >= ?`;
        params.push(normalizedStartDate);
    }
    
    if (endDate) {
        const normalizedEndDate = endDate.replace(/-/g, '/');
        query += ` AND sl.sale_date <= ?`;
        params.push(normalizedEndDate);
    }
    
    if (searchDriver) {
        query += ` AND LOWER(sl.driver_name) LIKE ? ESCAPE '\\'`;
        params.push(likeContains(searchDriver.toLowerCase()));
    }
    
    if (searchWaybill) {
        query += ` AND LOWER(sl.waybill_number) LIKE ? ESCAPE '\\'`;
        params.push(likeContains(searchWaybill.toLowerCase()));
    }
    
    // Apply balance filter if specified
    if (balance !== 'All') {
        // Need to join with customer balances and filter accordingly
        // This requires a subquery or additional JOIN to calculate customer balances
        if (balance === 'Green') {
            // Customers who owe us (positive balance)
            query += ` AND c.id IN (
                SELECT customer_id FROM (
                    SELECT customer_id, 
                           SUM(CASE WHEN amount_received > 0 THEN -amount_received ELSE net_cement_money END) as balance
                    FROM (
                        SELECT customer_id, net_cement_money, 0 as amount_received FROM sales_logs
                        UNION ALL
                        SELECT customer_id, 0, amount_received FROM receipts_logs
                    ) 
                    WHERE customer_id IN (SELECT id FROM customers WHERE LOWER(created_by) = LOWER(?))
                    GROUP BY customer_id
                    HAVING balance > 0
                )
            )`;
            params.push(req.session.username);
        } else if (balance === 'Red') {
            // Customers we owe (negative balance/prepaid)
            query += ` AND c.id IN (
                SELECT customer_id FROM (
                    SELECT customer_id, 
                           SUM(CASE WHEN amount_received > 0 THEN -amount_received ELSE net_cement_money END) as balance
                    FROM (
                        SELECT customer_id, net_cement_money, 0 as amount_received FROM sales_logs
                        UNION ALL
                        SELECT customer_id, 0, amount_received FROM receipts_logs
                    ) 
                    WHERE customer_id IN (SELECT id FROM customers WHERE LOWER(created_by) = LOWER(?))
                    GROUP BY customer_id
                    HAVING balance < 0
                )
            )`;
            params.push(req.session.username);
        } else if (balance === 'Zero') {
            // Settled customers (zero balance)
            query += ` AND c.id IN (
                SELECT customer_id FROM (
                    SELECT customer_id, 
                           SUM(CASE WHEN amount_received > 0 THEN -amount_received ELSE net_cement_money END) as balance
                    FROM (
                        SELECT customer_id, net_cement_money, 0 as amount_received FROM sales_logs
                        UNION ALL
                        SELECT customer_id, 0, amount_received FROM receipts_logs
                    ) 
                    WHERE customer_id IN (SELECT id FROM customers WHERE LOWER(created_by) = LOWER(?))
                    GROUP BY customer_id
                    HAVING balance = 0
                )
            )`;
            params.push(req.session.username);
        }
    }
    
    query += ` ORDER BY sl.sale_date DESC, sl.id DESC`;
    
    db.all(query, params, (err, rows) => {
        if (err) {
            console.error('[ERROR] Database error in apiWorkerAgentLogSubmissions:', err);
            db.close();
            return res.status(500).json({ error: 'Database error', details: 'Internal error' });
        }
        
        db.close();
        res.json({ records: rows });
    });
}

function workerAgentRemittances(req, res) {
    const db = getDbConnection();
    
    // Fetch customers registered by this worker only
    db.all('SELECT id, customer_id, name, province FROM customers WHERE LOWER(created_by) = LOWER(?) ORDER BY name ASC', [req.session.username], (err, customers) => {
        db.close();
        if (err) {
            return res.status(500).send('Database error');
        }
        
        res.render('worker_agent_remittances', {
            title: 'My Financial Remittance Ledger',
            user: req.user,
            customers: customers || []
        });
    });
}

function apiWorkerRemittanceLedger(req, res) {
    if (!req.session.role || req.session.role !== 'worker') {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const db = getDbConnection();
    
    // Get filter parameters
    const province = req.query.province || 'All';
    const customerId = req.query.customer_id || 'All';
    const source = req.query.source || 'All';
    const startDate = req.query.start_date || '';
    const endDate = req.query.end_date || '';
    const searchSender = req.query.search_sender || '';
    const searchSourceName = req.query.search_source_name || '';
    const searchRemittanceNumber = req.query.search_remittance_number || '';
    const searchAmount = req.query.search_amount || '';
    
    // Build base query with worker ownership filter
    let query = `
        SELECT 
            rl.id,
            rl.receipt_date,
            c.id as customer_id,
            c.name as customer_name,
            c.province as customer_province,
            c.customer_id as customer_customer_id,
            c.phone as customer_phone,
            c.address as customer_address,
            c.email as customer_email,
            rl.sender_name,
            rl.origin_source,
            rl.remittance_number,
            rl.amount_received,
            rl.is_posted,
            rl.receiving_station,
            u.username as submitted_by
        FROM receipts_logs rl
        LEFT JOIN customers c ON rl.customer_id = c.id
        LEFT JOIN users u ON rl.user_id = u.id
        WHERE LOWER(c.created_by) = LOWER(?)
    `;
    
    const params = [req.session.username];
    
    // Apply additional filters
    if (province !== 'All') {
        query += ` AND c.province = ?`;
        params.push(province);
    }
    
    if (customerId !== 'All') {
        query += ` AND c.id = ?`;
        params.push(parseInt(customerId));
    }
    
    if (source !== 'All') {
        query += ` AND rl.origin_source_type = ?`;
        params.push(source);
    }
    
    if (startDate) {
        const normalizedStartDate = startDate.replace(/-/g, '/');
        query += ` AND rl.receipt_date >= ?`;
        params.push(normalizedStartDate);
    }
    
    if (endDate) {
        const normalizedEndDate = endDate.replace(/-/g, '/');
        query += ` AND rl.receipt_date <= ?`;
        params.push(normalizedEndDate);
    }
    
    if (searchSender) {
        query += ` AND LOWER(rl.sender_name) LIKE ? ESCAPE '\\'`;
        params.push(likeContains(searchSender.toLowerCase()));
    }
    
    if (searchSourceName) {
        query += ` AND LOWER(rl.origin_source) LIKE ? ESCAPE '\\'`;
        params.push(likeContains(searchSourceName.toLowerCase()));
    }
    
    if (searchRemittanceNumber) {
        query += ` AND LOWER(rl.remittance_number) LIKE ? ESCAPE '\\'`;
        params.push(likeContains(searchRemittanceNumber.toLowerCase()));
    }
    
    if (searchAmount) {
        query += ` AND rl.amount_received = ?`;
        params.push(parseFloat(searchAmount));
    }
    
    query += ` ORDER BY rl.receipt_date DESC, rl.id DESC`;
    
    db.all(query, params, (err, rows) => {
        if (err) {
            console.error('[ERROR] Database error in apiWorkerRemittanceLedger:', err);
            db.close();
            return res.status(500).json({ error: 'Database error', details: 'Internal error' });
        }
        
        db.close();
        res.json({ records: rows });
    });
}

function workerDailyExpenses(req, res) {
    const db = getDbConnection();
    
    // Fetch expenses for this worker only
    db.all('SELECT * FROM agency_expenses WHERE agency_username = ? ORDER BY transaction_date DESC, id DESC', [req.session.username], (err, expenses) => {
        db.close();
        if (err) {
            return res.status(500).send('Database error');
        }
        
        res.render('worker_daily_expenses', {
            title: 'Daily Expenses & Cash Flow Management',
            user: req.user,
            expenses: expenses || [],
            user_agency: req.session.username
        });
    });
}

function workerAddExpense(req, res) {
    if (!req.session.role || req.session.role !== 'worker') {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const db = getDbConnection();
    
    const {
        transaction_date,
        category,
        description,
        person_involved,
        quantity,
        unit_price,
        cash_in,
        cash_out,
        remarks
    } = req.body;
    
    // Calculate total_price from quantity * unit_price
    const total_price = (parseFloat(quantity) || 0) * (parseFloat(unit_price) || 0);
    
    const query = `
        INSERT INTO agency_expenses 
        (agency_username, transaction_date, category, description, person_involved, quantity, unit_price, total_price, cash_in, cash_out, remarks)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    const params = [
        req.session.username,
        transaction_date,
        category,
        description,
        person_involved,
        parseFloat(quantity) || 1,
        parseFloat(unit_price) || 0,
        total_price,
        parseFloat(cash_in) || 0,
        parseFloat(cash_out) || 0,
        remarks
    ];
    
    db.run(query, params, function(err) {
        if (err) {
            console.error('[ERROR] Error adding expense:', err);
            db.close();
            return res.status(500).json({ success: false, error: 'Database error', details: 'Internal error' });
        }
        
        const expenseId = this.lastID;
        
        // Create admin notification for agency expense
        const agencyName = req.session.agency_name || req.session.username;
        const notificationMessage = `گزارش مصارف روز ${transaction_date} از نمایندگی ${agencyName} دریافت شد`;
        
        db.run(`
            INSERT INTO admin_notifications (type, message, related_record_type, related_record_id, agency_name, created_by, recipient)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, ['agency_expense_report_received', notificationMessage, 'agency_expense', expenseId, agencyName, req.session.username, 'admin'], (notifErr) => {
            if (notifErr) {
                console.error('Error creating notification:', notifErr);
            }
            db.close();
            res.json({ success: true, id: expenseId });
        });
    });
}

function apiWorkerExpenses(req, res) {
    if (!req.session.role || req.session.role !== 'worker') {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    
    const db = getDbConnection();
    
    // Get filter parameters - check both plural and singular parameter names
    const rawCategories = req.query.categories || req.query.category || req.query.adv_category;
    const startDate = req.query.start_date || '';
    const endDate = req.query.end_date || '';
    
    // Advanced filter parameters
    const advStartDate = req.query.adv_start_date || '';
    const advEndDate = req.query.adv_end_date || '';
    const advPerson = req.query.adv_person || '';
    const advCashIn = req.query.adv_cash_in || '';
    const advCashOut = req.query.adv_cash_out || '';
    const advDescription = req.query.adv_description || '';
    const advQuantity = req.query.adv_quantity || '';
    const advUnitPrice = req.query.adv_unit_price || '';
    const advRemarks = req.query.adv_remarks || '';
    
    console.log('[DEBUG] rawCategories:', rawCategories);
    console.log('[DEBUG] advStartDate:', advStartDate);
    console.log('[DEBUG] advEndDate:', advEndDate);
    
    // Build base query with worker ownership filter
    let query = `SELECT * FROM agency_expenses WHERE agency_username = ?`;
    const params = [req.session.username];
    
    // Category Filter
    if (rawCategories && rawCategories !== 'All' && rawCategories.trim() !== '') {
        const categoryArray = rawCategories.split(',').map(c => c.trim()).filter(c => c);
        
        console.log('[DEBUG] categoryArray:', categoryArray);
        
        if (categoryArray.length > 0) {
            const placeholders = categoryArray.map(() => '?').join(',');
            query += ` AND (category IN (${placeholders}))`;
            params.push(...categoryArray);
            console.log('[DEBUG] Query with category filter:', query);
            console.log('[DEBUG] Params:', params);
        }
    }
    
    // Date Range Filtering (prioritize modal date range if present, else main date range)
    const effectiveStartDate = (advStartDate && advStartDate.trim() !== '') ? advStartDate.trim() : (startDate ? startDate.trim() : '');
    const effectiveEndDate = (advEndDate && advEndDate.trim() !== '') ? advEndDate.trim() : (endDate ? endDate.trim() : '');
    
    if (effectiveStartDate) {
        const normalizedStartDate = effectiveStartDate.replace(/-/g, '/');
        query += ` AND (transaction_date >= ?)`;
        params.push(normalizedStartDate);
    }
    if (effectiveEndDate) {
        const normalizedEndDate = effectiveEndDate.replace(/-/g, '/');
        query += ` AND (transaction_date <= ?)`;
        params.push(normalizedEndDate);
    }
    
    // Text Search Filters (Partial Match - SQLite LIKE is case-insensitive for ASCII)
    if (advPerson && advPerson.trim() !== '') {
        query += ` AND (person_involved LIKE ? ESCAPE '\\')`;
        params.push(likeContains(advPerson.trim()));
    }
    if (advDescription && advDescription.trim() !== '') {
        query += ` AND (description LIKE ? ESCAPE '\\')`;
        params.push(likeContains(advDescription.trim()));
    }
    if (advRemarks && advRemarks.trim() !== '') {
        query += ` AND (remarks LIKE ? ESCAPE '\\')`;
        params.push(likeContains(advRemarks.trim()));
    }
    
    // Numeric Match Filters
    if (advCashIn && !isNaN(parseFloat(advCashIn))) {
        query += ` AND (cash_in = ?)`;
        params.push(parseFloat(advCashIn));
    }
    if (advCashOut && !isNaN(parseFloat(advCashOut))) {
        query += ` AND (cash_out = ?)`;
        params.push(parseFloat(advCashOut));
    }
    if (advQuantity && !isNaN(parseFloat(advQuantity))) {
        query += ` AND (quantity = ?)`;
        params.push(parseFloat(advQuantity));
    }
    if (advUnitPrice && !isNaN(parseFloat(advUnitPrice))) {
        query += ` AND (unit_price = ?)`;
        params.push(parseFloat(advUnitPrice));
    }
    
    query += ` ORDER BY transaction_date DESC, id DESC`;
    
    console.log('[DEBUG] Final query:', query);
    console.log('[DEBUG] Final params:', params);
    
    db.all(query, params, (err, rows) => {
        if (err) {
            console.error('[ERROR] Database error in apiWorkerExpenses:', err);
            db.close();
            return res.status(500).json({ success: false, error: 'Database error', details: 'Internal error' });
        }
        
        console.log('[DEBUG] Returned rows count:', rows.length);
        db.close();
        res.json({ success: true, records: rows });
    });
}

function apiWorkerExpensesSummary(req, res) {
    if (!req.session.role || req.session.role !== 'worker') {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    
    const db = getDbConnection();
    
    const startDate = req.query.start_date || '';
    const endDate = req.query.end_date || '';
    
    // Build query with worker ownership filter
    let query = `
        SELECT 
            SUM(cash_in) as total_cash_in,
            SUM(cash_out) as total_cash_out,
            COUNT(*) as transaction_count
        FROM agency_expenses 
        WHERE agency_username = ?
    `;
    const params = [req.session.username];
    
    if (startDate) {
        const normalizedStartDate = startDate.replace(/-/g, '/');
        query += ` AND transaction_date >= ?`;
        params.push(normalizedStartDate);
    }
    
    if (endDate) {
        const normalizedEndDate = endDate.replace(/-/g, '/');
        query += ` AND transaction_date <= ?`;
        params.push(normalizedEndDate);
    }
    
    db.get(query, params, (err, row) => {
        if (err) {
            console.error('[ERROR] Database error in apiWorkerExpensesSummary:', err);
            db.close();
            return res.status(500).json({ success: false, error: 'Database error', details: 'Internal error' });
        }
        
        const totalCashIn = row.total_cash_in || 0;
        const totalCashOut = row.total_cash_out || 0;
        const currentBalance = totalCashIn - totalCashOut;
        
        // Reimbursement due is the absolute value of negative balance
        const reimbursementDue = currentBalance < 0 ? Math.abs(currentBalance) : 0;
        
        db.close();
        res.json({
            success: true,
            total_cash_in: totalCashIn,
            total_cash_out: totalCashOut,
            current_balance: currentBalance,
            reimbursement_due: reimbursementDue,
            transaction_count: row.transaction_count || 0
        });
    });
}

function workerAddExpensesBatch(req, res) {
    if (!req.session.role || req.session.role !== 'worker') {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    
    const db = getDbConnection();
    
    const expenses = req.body.expenses || [];
    
    if (!Array.isArray(expenses) || expenses.length === 0) {
        db.close();
        return res.status(400).json({ success: false, error: 'No expenses provided' });
    }
    
    const query = `
        INSERT INTO agency_expenses 
        (agency_username, transaction_date, category, description, person_involved, quantity, unit_price, total_price, cash_in, cash_out, remarks)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    let insertedCount = 0;
    
    // Sequential insertion to ensure proper error handling
    function insertNext(index) {
        if (index >= expenses.length) {
            db.close();
            return res.json({ success: true, count: insertedCount });
        }
        
        const expense = expenses[index];
        const params = [
            req.session.username,
            expense.transaction_date,
            expense.category,
            expense.description || '',
            expense.person_involved || '',
            expense.quantity || 1,
            expense.unit_price || 0,
            expense.total_price || 0,
            expense.cash_in || 0,
            expense.cash_out || 0,
            expense.remarks || ''
        ];
        
        db.run(query, params, function(err) {
            if (err) {
                console.error('[ERROR] Error inserting expense batch:', err);
                db.close();
                return res.status(500).json({ success: false, error: 'Database error', details: 'Internal error' });
            }
            
            insertedCount++;
            insertNext(index + 1);
        });
    }
    
    insertNext(0);
}

function apiWorkerIncomingWaybills(req, res) {
    console.log('[DEBUG] apiWorkerIncomingWaybills called');
    console.log('[DEBUG] Session role:', req.session.role);
    console.log('[DEBUG] Session username:', req.session.username);
    console.log('[DEBUG] Session province:', req.session.province);
    console.log('[DEBUG] Session assigned_province:', req.session.assigned_province);
    
    if (req.session.role !== 'worker') {
        console.log('[DEBUG] Unauthorized - not a worker');
        return res.status(403).json({ error: 'Unauthorized' });
    }

    const username = req.session.username || '';
    console.log('[DEBUG] Using username for selled_to_agent match:', username);
    
    const db = getDbConnection();

    const query = `
        SELECT * FROM local_waybills 
        WHERE LOWER(selled_to_agent) = LOWER(?) AND (status IS NULL OR status = 'available')
        ORDER BY id DESC
    `;
    console.log('[DEBUG] SQL Query:', query);
    console.log('[DEBUG] Query parameter:', username);

    db.all(query, [username], (err, rows) => {
        db.close();
        if (err) {
            console.error('[ERROR] Error fetching incoming waybills:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        console.log('[DEBUG] Number of waybills returned:', rows.length);
        console.log('[DEBUG] Waybills data:', rows);
        res.json({ waybills: rows || [] });
    });
}

function apiWorkerMarkWaybillInQueue(req, res) {
    console.log('[DEBUG] apiWorkerMarkWaybillInQueue called');
    console.log('[DEBUG] Session role:', req.session.role);
    console.log('[DEBUG] Request body:', req.body);
    
    if (req.session.role !== 'worker') {
        console.log('[DEBUG] Unauthorized - not a worker');
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const { waybill_id } = req.body;
    
    if (!waybill_id) {
        console.log('[DEBUG] Missing waybill_id');
        return res.status(400).json({ success: false, error: 'Waybill ID required' });
    }

    const db = getDbConnection();

    db.run(`
        UPDATE local_waybills 
        SET status = 'in_queue'
        WHERE id = ? AND (status IS NULL OR status = 'available')
    `, [waybill_id], function(err) {
        if (err) {
            console.error('[ERROR] Error marking waybill as in_queue:', err);
            db.close();
            return res.status(500).json({ success: false, error: 'Database error' });
        }
        
        console.log('[DEBUG] Update changes:', this.changes);
        
        if (this.changes === 0) {
            console.log('[DEBUG] Waybill not found or already processed');
            db.close();
            return res.status(404).json({ success: false, error: 'Waybill not found or already processed' });
        }
        
        console.log('[DEBUG] Waybill marked as in_queue successfully:', waybill_id);
        db.close();
        res.json({ success: true });
    });
}

function apiWorkerMarkWaybillAvailable(req, res) {
    if (req.session.role !== 'worker') {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const { waybill_id } = req.body;
    
    if (!waybill_id) {
        return res.status(400).json({ success: false, error: 'Waybill ID required' });
    }

    const db = getDbConnection();

    db.run(`
        UPDATE local_waybills 
        SET status = 'available'
        WHERE id = ? AND status = 'in_queue'
    `, [waybill_id], function(err) {
        db.close();
        if (err) {
            console.error('[ERROR] Error marking waybill as available:', err);
            return res.status(500).json({ success: false, error: 'Database error' });
        }
        
        console.log('[DEBUG] Waybill marked as available:', waybill_id);
        res.json({ success: true });
    });
}

function apiWorkerWaitingQueue(req, res) {
    console.log('[DEBUG] apiWorkerWaitingQueue called');
    
    if (req.session.role !== 'worker') {
        console.log('[DEBUG] Unauthorized - not a worker');
        return res.status(403).json({ error: 'Unauthorized' });
    }

    const username = req.session.username || '';
    console.log('[DEBUG] Using username for selled_to_agent match:', username);
    
    const db = getDbConnection();

    const query = `
        SELECT * FROM local_waybills 
        WHERE LOWER(selled_to_agent) = LOWER(?) AND status = 'in_queue'
        ORDER BY id DESC
    `;
    console.log('[DEBUG] SQL Query:', query);
    console.log('[DEBUG] Query parameter:', username);

    db.all(query, [username], (err, rows) => {
        db.close();
        if (err) {
            console.error('[ERROR] Error fetching waiting queue:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        console.log('[DEBUG] Number of waybills in waiting queue:', rows.length);
        console.log('[DEBUG] Waiting queue data:', rows);
        res.json({ waybills: rows || [] });
    });
}

function apiWorkerCommitWaybillSalesBatch(req, res) {
    console.log('[DEBUG] apiWorkerCommitWaybillSalesBatch called');
    console.log('[DEBUG] Session username:', req.session.username);
    console.log('[DEBUG] Session role:', req.session.role);
    console.log('[DEBUG] Session ID:', req.sessionID);
    
    if (req.session.role !== 'worker') {
        console.log('[DEBUG] Unauthorized - not a worker');
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const { salesBatch } = req.body;
    const username = req.session.username || '';

    console.log('[DEBUG] Sales batch length:', salesBatch ? salesBatch.length : 0);

    if (!salesBatch || !Array.isArray(salesBatch) || salesBatch.length === 0) {
        return res.status(400).json({ success: false, error: 'هیچ رکوردی برای ارسال انتخاب نشده است' });
    }

    // Check for duplicate waybill IDs in the batch
    const waybillIds = salesBatch.map(item => item.waybill_id);
    const uniqueWaybillIds = [...new Set(waybillIds)];
    if (waybillIds.length !== uniqueWaybillIds.length) {
        return res.status(400).json({ success: false, error: 'تکرار بارنامه در لیست: یک بارنامه نمی‌تواند دو بار ارسال شود' });
    }

    const db = getDbConnection();
    
    // Begin transaction
    db.run('BEGIN TRANSACTION', function(err) {
        if (err) {
            console.error('[ERROR] Failed to begin transaction:', err);
            console.error('[ERROR] SQL Error Details:', err.message);
            db.close();
            return res.status(500).json({ success: false, error: 'خطا در شروع تراکنش' });
        }

        let processedCount = 0;
        let hasError = false;

        function processNext(index) {
            if (index >= salesBatch.length || hasError) {
                if (hasError) {
                    db.run('ROLLBACK', function(rollbackErr) {
                        if (rollbackErr) console.error('[ERROR] Rollback failed:', rollbackErr);
                        db.close();
                        return res.status(500).json({ success: false, error: 'خطا در ثبت گزارش فروش' });
                    });
                    return;
                }
                
                // Commit transaction
                db.run('COMMIT', function(commitErr) {
                    if (commitErr) {
                        console.error('[ERROR] Commit failed:', commitErr);
                        return res.status(500).json({ success: false, error: 'خطا در تایید تراکنش' });
                    }
                    
                    // Create notification for sales report sent to Admin
                    const agencyName = req.session.agency_name || req.session.username;
                    const waybillNumber = salesBatch[0].waybill_serial || 'ناشناخته';
                    const customerName = salesBatch[0].customer_name || 'ناشناخته';
                    const notificationMessage = `گزارش بارنامه شماره ${waybillNumber} مربوط به مشتری ${customerName} با موفقیت به اداره مرکزی ارسال شد`;
                    
                    console.log('[DEBUG] Creating worker_sales_report_sent notification for Admin');
                    console.log('[DEBUG] Waybill number:', waybillNumber);
                    console.log('[DEBUG] Customer name:', customerName);
                    console.log('[DEBUG] Recipient: admin');
                    
                    db.run(`
                        INSERT INTO admin_notifications (type, message, related_record_id, related_record_type, created_by, recipient, is_read, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
                    `, ['worker_sales_report_sent', notificationMessage, null, 'sales_report', req.session.username, 'admin'], function(notifErr) {
                        if (notifErr) {
                            console.error('[ERROR] Error creating worker sales report sent notification for admin:', notifErr);
                        } else {
                            const adminNotificationId = this.lastID;
                            console.log('[DEBUG] Worker sales report sent notification created for admin, ID:', adminNotificationId);
                            
                            // Broadcast the notification via SSE to admins
                            const adminNotification = {
                                id: adminNotificationId,
                                type: 'worker_sales_report_sent',
                                message: notificationMessage,
                                related_record_id: null,
                                related_record_type: 'sales_report',
                                created_by: req.session.username,
                                recipient: 'admin',
                                is_read: 0,
                                created_at: new Date().toISOString()
                            };
                            console.log('[DEBUG] Broadcasting notification via SSE to admins:', adminNotification);
                            notificationSSE.broadcast(adminNotification);
                        }
                    });
                    
                    // Create confirmation notification for the Worker who submitted the report
                    console.log('[DEBUG] Creating worker_sales_report_sent_confirmation notification for Worker');
                    console.log('[DEBUG] Recipient:', req.session.username);
                    
                    db.run(`
                        INSERT INTO admin_notifications (type, message, related_record_id, related_record_type, created_by, recipient, is_read, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
                    `, ['worker_sales_report_sent_confirmation', notificationMessage, null, 'sales_report', req.session.username, req.session.username], function(workerNotifErr) {
                        if (workerNotifErr) {
                            console.error('[ERROR] Error creating worker confirmation notification:', workerNotifErr);
                        } else {
                            const workerNotificationId = this.lastID;
                            console.log('[DEBUG] Worker confirmation notification created, ID:', workerNotificationId);
                            
                            // Broadcast the notification via SSE to the worker
                            const workerNotification = {
                                id: workerNotificationId,
                                type: 'worker_sales_report_sent_confirmation',
                                message: notificationMessage,
                                related_record_id: null,
                                related_record_type: 'sales_report',
                                created_by: req.session.username,
                                recipient: req.session.username,
                                is_read: 0,
                                created_at: new Date().toISOString()
                            };
                            console.log('[DEBUG] Broadcasting notification via SSE to worker:', workerNotification);
                            notificationSSE.broadcast(workerNotification);
                        }
                    });
                    
                    db.close();
                    return res.json({ success: true, count: processedCount });
                });
                return;
            }

            const item = salesBatch[index];

            // Parse customer field to extract customer_id and customer_name
            // Expected format: customer_id is now the customer code (e.g., KAB-002)
            let customerCode = item.customer_id;
            let customerName = item.customer_name;
            
            // If customer_id is a database ID (number), we need to look up the code
            if (!isNaN(parseInt(customerCode))) {
                // This is a database ID, look up the customer code
                db.get('SELECT customer_id, name FROM customers WHERE id = ?', [parseInt(customerCode)], (err, customerRow) => {
                    if (err) {
                        console.error('[ERROR] Error looking up customer by ID:', err);
                        hasError = true;
                        processNext(salesBatch.length);
                        return;
                    }

                    if (!customerRow) {
                        console.error('[ERROR] Customer not found for ID:', customerCode);
                        hasError = true;
                        processNext(salesBatch.length);
                        return;
                    }

                    customerCode = customerRow.customer_id;
                    customerName = customerRow.name;
                    
                    // Continue with the rest of the processing
                    processItemWithCustomerCode(customerCode, customerName, item, index);
                });
                return;
            }

            // customer_id is already a code, proceed directly
            processItemWithCustomerCode(customerCode, customerName, item, index);
        }

        function processItemWithCustomerCode(customerCode, customerName, item, index) {

            // Clean numeric fields by removing commas and converting to numbers
            const cleanNumber = (val) => {
                if (typeof val === 'string') {
                    return Number(val.toString().replace(/,/g, '')) || 0;
                }
                return Number(val) || 0;
            };

            const totalBags = cleanNumber(item.total_bags);
            const tonnage = cleanNumber(item.tonnage);
            const shortageBags = cleanNumber(item.shortage_bags);
            const saleUnitPrice = cleanNumber(item.sale_unit_price);
            const totalSaleAmount = cleanNumber(item.total_sale_amount);
            const freightPerTon = cleanNumber(item.freight_per_ton);
            const totalFreight = cleanNumber(item.total_freight);

            // Server-side validation and calculation
            const calculatedTotalSales = totalBags * saleUnitPrice;
            const calculatedTotalFreight = tonnage * freightPerTon;
            
            // Use client-provided values if valid, otherwise use calculated
            const finalTotalSales = totalSaleAmount > 0 ? totalSaleAmount : calculatedTotalSales;
            const finalTotalFreight = totalFreight > 0 ? totalFreight : calculatedTotalFreight;
            const netCementMoney = finalTotalSales - finalTotalFreight;

            // Look up actual customer integer ID from customers table using customer code
            db.get('SELECT id FROM customers WHERE customer_id = ?', [customerCode], (err, customerRow) => {
                if (err) {
                    console.error('[ERROR] Error looking up customer:', err);
                    hasError = true;
                    processNext(salesBatch.length);
                    return;
                }

                const actualCustomerId = customerRow ? customerRow.id : null;

                if (!actualCustomerId) {
                    console.error('[ERROR] Customer not found for code:', customerCode);
                    hasError = true;
                    processNext(salesBatch.length);
                    return;
                }

                // 1. Insert into sales_logs (table used by Admin Dashboard)
                db.run(`
                    INSERT INTO sales_logs (
                        sale_date, customer_id, driver_name, car_plate,
                        waybill_number, cement_type, bags_count, tonnage, shortage,
                        unit_price_bag, total_sales_money, freight_per_ton,
                        total_freight, net_cement_money, is_company_car,
                        province_origin, user_id, is_posted
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                `, [
                    item.sale_date,
                    actualCustomerId, // Use actual integer customer ID
                    item.driver_name,
                    item.truck_plate,
                    item.waybill_serial,
                    item.cement_type || 'Baqran',
                    totalBags,
                    tonnage,
                    shortageBags,
                    saleUnitPrice,
                    finalTotalSales,
                    freightPerTon,
                    finalTotalFreight,
                    netCementMoney,
                    item.truck_type === 'company' ? 1 : 0,
                    item.province || req.session.assigned_province || 'Kabul',
                    req.session.user_id
                ], function(err) {
                    if (err) {
                        console.error('[ERROR] Error inserting sales log:', err);
                        console.error('[ERROR] SQL Error Details:', err.message);
                        console.error('[ERROR] Failed item data:', JSON.stringify({
                            sale_date: item.sale_date,
                            customer_id: actualCustomerId,
                            customer_code: customerCode,
                            customer_name: customerName,
                            driver_name: item.driver_name,
                            truck_plate: item.truck_plate,
                            waybill_serial: item.waybill_serial,
                            cement_type: item.cement_type,
                            total_bags: totalBags,
                            tonnage: tonnage,
                            shortage_bags: shortageBags,
                            sale_unit_price: saleUnitPrice,
                            total_sale_amount: finalTotalSales,
                            freight_per_ton: freightPerTon,
                            total_freight: finalTotalFreight,
                            net_cement_money: netCementMoney
                        }));
                        hasError = true;
                        processNext(salesBatch.length); // Skip to end
                        return;
                    }

                    // 2. Mark waybill as 'posted_sold' in local_waybills
                    // First, fetch current status for debugging and to check for status change
                    db.get('SELECT id, waybill_serial, status FROM local_waybills WHERE id = ?', [item.waybill_id], (err, row) => {
                        if (err) {
                            console.error('[ERROR] Error fetching waybill before update:', err);
                        } else if (row) {
                            console.log('[DEBUG] Waybill BEFORE update:', { id: row.id, serial: row.waybill_serial, status: row.status });
                            
                            const oldStatus = row.status;
                            const waybillSerial = row.waybill_serial;
                            
                            db.run(`
                                UPDATE local_waybills 
                                SET status = 'posted_sold',
                                    sale_date = ?,
                                    customer_id = ?,
                                    customer_name = ?,
                                    shortage_bags = ?,
                                    sale_unit_price = ?,
                                    total_sale_amount = ?,
                                    net_cement_money = ?
                                WHERE id = ?
                            `, [
                                item.sale_date, customerCode, customerName,
                                shortageBags, saleUnitPrice, finalTotalSales, netCementMoney,
                                item.waybill_id
                            ], function(err) {
                                if (err) {
                                    console.error('[ERROR] Error updating waybill status:', err);
                                    console.error('[ERROR] SQL Error Details:', err.message);
                                    console.error('[ERROR] Failed waybill_id:', item.waybill_id);
                                    hasError = true;
                                } else {
                                    // Fetch status after update for debugging
                                    db.get('SELECT id, waybill_serial, status FROM local_waybills WHERE id = ?', [item.waybill_id], (err, row) => {
                                        if (err) {
                                            console.error('[ERROR] Error fetching waybill after update:', err);
                                        } else if (row) {
                                            console.log('[DEBUG] Waybill AFTER update:', { id: row.id, serial: row.waybill_serial, status: row.status });
                                        }
                                    });
                                    
                                    // Create notification for waybill sold status (Event 5)
                                    // Only create if status actually changed to 'posted_sold'
                                    if (oldStatus !== 'posted_sold') {
                                        const agencyName = req.session.agency_name || req.session.username;
                                        const notificationMessage = `بارنامه شماره ${waybillSerial} توسط نمایندگی ${agencyName} فروخته شد`;
                                        
                                        db.run(`
                                            INSERT INTO admin_notifications (type, message, related_record_id, related_record_type, agency_name, created_by, is_read, created_at)
                                            VALUES (?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
                                        `, ['waybill_sold', notificationMessage, item.waybill_id, 'local_waybill', agencyName, req.session.username], (notifErr) => {
                                            if (notifErr) {
                                                console.error('[ERROR] Error creating waybill sold notification:', notifErr);
                                            } else {
                                                console.log('[DEBUG] Waybill sold notification created for:', waybillSerial);
                                            }
                                        });
                                    }
                                    
                                    processedCount++;
                                }
                                processNext(index + 1);
                            });
                        } else {
                            hasError = true;
                            processNext(index + 1);
                        }
                    });
                });
            });
        }

        processNext(0);
    });
}

function apiWorkerSellWaybillDirect(req, res) {
    if (req.session.role !== 'worker') {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const {
        waybill_id,
        sale_date,
        customer_id,
        customer_name,
        shortage_bags,
        sale_unit_price,
        total_sale_amount
    } = req.body;

    const username = req.session.username || '';

    if (!waybill_id || !sale_date || !customer_id || !sale_unit_price) {
        return res.status(400).json({ success: false, error: 'اطلاعات ضروری کامل نمی‌باشد.' });
    }

    const db = getDbConnection();

    // Fetch original waybill details
    db.get(`SELECT * FROM local_waybills WHERE id = ?;`, [waybill_id], (err, wb) => {
        if (err) {
            console.error('[ERROR] Error fetching waybill:', err);
            db.close();
            return res.status(500).json({ success: false, error: 'Database error' });
        }

        if (!wb) {
            db.close();
            return res.status(404).json({ success: false, error: 'بارنامه مورد نظر یافت نشد.' });
        }

        // 1. Insert directly into daily_logs
        // F-A2: the column list said "created_by" but the daily_logs schema
        // (config/database.js) defines "created_by_agency" — SQLite rejected
        // the INSERT with "table daily_logs has no column named created_by"
        // and the endpoint 500ed for every worker. Value semantics unchanged:
        // the submitting worker's username goes into created_by_agency.
        db.run(`
            INSERT INTO daily_logs (
                sale_date, customer_id, customer_name, driver_name, car_plate,
                waybill_number, cement_type, bags_count, tonnage, shortage,
                unit_price_bag, total_sales_money, truck_type, freight_per_ton,
                total_freight, created_by_agency, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `, [
            sale_date,
            customer_id,
            customer_name,
            wb.driver_name,
            wb.truck_plate,
            wb.waybill_serial,
            wb.cement_type || 'سمنت باقران',
            wb.total_bags,
            wb.tonnage,
            shortage_bags || 0,
            sale_unit_price,
            total_sale_amount,
            wb.truck_type || 'company',
            wb.freight_per_ton || 0,
            wb.total_freight || 0,
            username
        ], function(err) {
            if (err) {
                console.error('[ERROR] Error inserting daily log:', err);
                db.close();
                return res.status(500).json({ success: false, error: 'خطا در ثبت گزارش فروش' });
            }

            // 2. Mark waybill as 'posted_sold' in local_waybills
            db.run(`
                UPDATE local_waybills 
                SET status = 'posted_sold',
                    sale_date = ?,
                    customer_id = ?,
                    customer_name = ?,
                    shortage_bags = ?,
                    sale_unit_price = ?,
                    total_sale_amount = ?
                WHERE id = ?
            `, [
                sale_date, customer_id, customer_name,
                shortage_bags || 0, sale_unit_price, total_sale_amount,
                waybill_id
            ], function(err) {
                db.close();
                if (err) {
                    console.error('[ERROR] Error updating waybill status:', err);
                    return res.status(500).json({ success: false, error: 'خطا در به‌روزرسانی وضعیت بارنامه' });
                }
                return res.json({ success: true });
            });
        });
    });
}

// Quotation Requests Management for Workers
function workerQuotationRequests(req, res) {
    res.render('worker_quotation_requests');
}

function apiWorkerQuotationRequests(req, res) {
    if (!req.session.role || req.session.role !== 'worker') {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    const { status, source } = req.query;
    const workerUsername = req.session.username;
    const db = getDbConnection();

    let query = 'SELECT * FROM quotation_requests WHERE assigned_worker_username = ?';
    const params = [workerUsername];

    if (status && status !== 'all') {
        query += ' AND status = ?';
        params.push(status);
    }
    if (source && source !== 'all') {
        query += ' AND source_type = ?';
        params.push(source);
    }

    query += ' ORDER BY created_at DESC';

    db.all(query, params, (err, rows) => {
        db.close();
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        res.json(rows);
    });
}

function apiWorkerQuotationRequestDetails(req, res) {
    if (!req.session.role || req.session.role !== 'worker') {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    const { id } = req.params;
    const workerUsername = req.session.username;
    const db = getDbConnection();

    // Security check: verify request belongs to this worker
    db.get('SELECT * FROM quotation_requests WHERE id = ? AND assigned_worker_username = ?', [id, workerUsername], (err, row) => {
        db.close();
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        if (!row) {
            return res.status(404).json({ error: 'Request not found or access denied' });
        }
        res.json(row);
    });
}

function apiWorkerUpdateQuotationRequestStatus(req, res) {
    if (!req.session.role || req.session.role !== 'worker') {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    const { request_id, status, notes } = req.body;
    const workerUsername = req.session.username;
    const db = getDbConnection();

    // Security check: verify request belongs to this worker
    db.get('SELECT id FROM quotation_requests WHERE id = ? AND assigned_worker_username = ?', [request_id, workerUsername], (err, row) => {
        if (err) {
            db.close();
            return res.status(500).json({ error: 'Database error' });
        }
        if (!row) {
            db.close();
            return res.status(404).json({ error: 'Request not found or access denied' });
        }

        // Update status
        db.run(`
            UPDATE quotation_requests 
            SET status = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [status, request_id], function(err) {
            db.close();
            if (err) {
                return res.status(500).json({ error: 'Failed to update status' });
            }
            res.json({ success: true });
        });
    });
}

// Cement Summary Report API (Worker-scoped)
function apiWorkerCementSummaryReport(req, res) {
    if (!req.session.role || req.session.role !== 'worker') {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    const { startDate, endDate } = req.query;
    const db = getDbConnection();

    // Get all registered cement types
    db.all('SELECT cement_name FROM cement_types ORDER BY cement_name', (err, cementTypes) => {
        if (err) {
            db.close();
            return res.status(500).json({ error: 'Database error fetching cement types' });
        }

        // Get cement type names
        const cementTypeNames = cementTypes.map(ct => ct.cement_name);
        
        // If no cement types registered, return empty result
        if (cementTypeNames.length === 0) {
            db.close();
            return res.json({ records: [], totals: null });
        }

        // Build SQL query to aggregate data by cement type from sales_logs (worker-scoped)
        const cementTypePlaceholders = cementTypeNames.map(() => '?').join(',');
        let query = `
            SELECT 
                sl.cement_type,
                COUNT(DISTINCT sl.waybill_number) as total_waybills,
                SUM(sl.bags_count) as total_bags,
                SUM(sl.tonnage) as total_tonnage,
                SUM(sl.shortage) as total_shortage,
                SUM(CASE WHEN sl.is_company_car = 1 THEN 1 ELSE 0 END) as company_trucks_count,
                SUM(CASE WHEN sl.is_company_car = 0 THEN 1 ELSE 0 END) as rental_trucks_count,
                SUM(sl.total_freight) as total_freight,
                SUM(sl.total_sales_money) as total_sales,
                SUM(sl.net_cement_money) as total_net_cement
            FROM sales_logs sl
            INNER JOIN customers c ON sl.customer_id = c.id
            WHERE sl.cement_type IN (${cementTypePlaceholders})
            AND LOWER(c.created_by) = LOWER(?)
        `;
        const params = [...cementTypeNames, req.session.username];

        // Add date filters if provided
        if (startDate) {
            query += ` AND sl.sale_date >= ?`;
            params.push(startDate);
        }
        if (endDate) {
            query += ` AND sl.sale_date <= ?`;
            params.push(endDate);
        }

        query += ` GROUP BY sl.cement_type`;

        db.all(query, params, (err, records) => {
            if (err) {
                db.close();
                return res.status(500).json({ error: 'Database error fetching summary data' });
            }

            // Create a map of cement type to its data for easy lookup
            const recordsMap = {};
            records.forEach(record => {
                recordsMap[record.cement_type] = record;
            });

            // Generate records for ALL cement types from master list
            const allRecords = cementTypeNames.map(cementName => {
                const data = recordsMap[cementName];
                if (data) {
                    return data;
                } else {
                    // Return zero record for cement types with no data
                    return {
                        cement_type: cementName,
                        total_waybills: 0,
                        total_bags: 0,
                        total_tonnage: 0,
                        total_shortage: 0,
                        company_trucks_count: 0,
                        rental_trucks_count: 0,
                        total_freight: 0,
                        total_sales: 0,
                        total_net_cement: 0
                    };
                }
            });

            // Calculate totals across all cement types
            const totals = {
                cement_type: 'جمع کل (Totals)',
                total_waybills: 0,
                total_bags: 0,
                total_tonnage: 0,
                total_shortage: 0,
                company_trucks_count: 0,
                rental_trucks_count: 0,
                total_freight: 0,
                total_sales: 0,
                total_net_cement: 0
            };

            allRecords.forEach(record => {
                totals.total_waybills += (record.total_waybills || 0);
                totals.total_bags += (record.total_bags || 0);
                totals.total_tonnage += (record.total_tonnage || 0);
                totals.total_shortage += (record.total_shortage || 0);
                totals.company_trucks_count += (record.company_trucks_count || 0);
                totals.rental_trucks_count += (record.rental_trucks_count || 0);
                totals.total_freight += (record.total_freight || 0);
                totals.total_sales += (record.total_sales || 0);
                totals.total_net_cement += (record.total_net_cement || 0);
            });

            db.close();
            res.json({ records: allRecords, totals });
        });
    });
}

function apiWorkerCustomerBalances(req, res) {
    const db = getDbConnection();
    
    // Worker authorization: only return customers created by this worker
    const query = `
        SELECT 
            c.id,
            c.customer_id,
            c.name,
            c.province,
            c.address,
            c.customer_type,
            c.email,
            c.phone,
            u.agency_name,
            COALESCE(SUM(sl.net_cement_money), 0) as total_cement_purchases,
            COALESCE(SUM(rl.amount_received), 0) as total_payments_receipts
        FROM customers c
        LEFT JOIN users u ON c.created_by = u.username
        LEFT JOIN sales_logs sl ON c.id = sl.customer_id
        LEFT JOIN receipts_logs rl ON c.id = rl.customer_id
        WHERE LOWER(c.created_by) = LOWER(?)
        GROUP BY c.id, c.customer_id, c.name, c.province, c.address, c.customer_type, c.email, c.phone, u.agency_name
        ORDER BY 
            CASE 
                WHEN COALESCE(SUM(sl.net_cement_money), 0) - COALESCE(SUM(rl.amount_received), 0) != 0 THEN 0
                ELSE 1
            END,
            c.name ASC
    `;
    
    db.all(query, [req.session.username], (err, customers) => {
        if (err) {
            db.close();
            return res.status(500).json({ error: 'Database error' });
        }
        
        // Calculate balances for each customer (same logic as Admin)
        const customerBalances = customers.map((customer, index) => {
            const totalDebit = customer.total_cement_purchases || 0;
            const totalCredit = customer.total_payments_receipts || 0;
            const balance = totalDebit - totalCredit;
            
            let companyOwesCustomer = 0;
            let customerOwesCompany = 0;
            
            if (balance > 0) {
                customerOwesCompany = balance;
            } else if (balance < 0) {
                companyOwesCustomer = Math.abs(balance);
            }
            
            return {
                '#': index + 1,
                'ID': customer.customer_id || `CUST-${customer.id}`,
                'Name': customer.name,
                'Agency': customer.agency_name || '-',
                'Province': customer.province,
                'Full Address': customer.address || '-',
                'Customer Type': customer.customer_type || '-',
                'Email': customer.email || '-',
                'Phone Number': customer.phone || '-',
                'Total Cement Purchases': totalDebit,
                'Total Payments / Receipts': totalCredit,
                'Company Owes Customer': companyOwesCustomer,
                'Customer Owes Company': customerOwesCompany
            };
        });
        
        db.close();
        res.json(customerBalances);
    });
}

function apiWorkerCustomerFinancialSummary(req, res) {
    if (!req.session.role || req.session.role !== 'worker') {
        return res.status(403).json({ error: 'Unauthorized - Worker access required' });
    }

    const db = getDbConnection();

    // Get optional filters
    const startDate = req.query.start_date || '';
    const endDate = req.query.end_date || '';
    const searchCustomer = req.query.search_customer || '';
    const balanceFilter = req.query.balance_status || 'All';
    const provinceFilter = req.query.province || 'All';

    // Build base query for customers with user info
    // CRITICAL: Filter by c.created_by to ensure worker only sees their own customers
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
        WHERE LOWER(c.created_by) = LOWER(?)
    `;

    const params = [req.session.username];

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
            // CRITICAL: Use customer.id (primary key) not customer.customer_id (display ID)
            // This matches the authoritative Customer Detail modal logic
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
            // CRITICAL: Use customer.id (primary key) not customer.customer_id (display ID)
            // This matches the authoritative Customer Detail modal logic
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
                            id: customer.customer_id,
                            customer_id: customer.customer_customer_id,
                            name: customer.customer_name,
                            province: customer.customer_province,
                            created_by: customer.customer_created_by,
                            total_debit: totalDebit,
                            total_credit: totalCredit,
                            balance: totalDebit - totalCredit,
                            transfer_count: totalTransfers,
                            bank_count: bankTransfers,
                            sarafi_count: sarafiTransfers
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
                    const netBalance = row.balance;
                    if (balanceFilter === 'customer_owes') return netBalance > 0.1;
                    if (balanceFilter === 'company_owes') return netBalance < -0.1;
                    if (balanceFilter === 'zero') return Math.abs(netBalance) <= 0.1;
                    return true;
                });
            }

            // Calculate totals from all filtered records (not just paginated)
            const totals = filteredData.reduce((acc, row) => {
                acc.total_debit += (row.total_debit || 0);
                acc.total_credit += (row.total_credit || 0);
                acc.company_owes_customer += (row.balance < 0 ? Math.abs(row.balance) : 0);
                acc.customer_owes_company += (row.balance > 0 ? row.balance : 0);
                acc.total_transfers += (row.transfer_count || 0);
                acc.bank_transfers += (row.bank_count || 0);
                acc.sarafi_transfers += (row.sarafi_count || 0);
                return acc;
            }, {
                total_debit: 0,
                total_credit: 0,
                company_owes_customer: 0,
                customer_owes_company: 0,
                total_transfers: 0,
                bank_transfers: 0,
                sarafi_transfers: 0
            });

            db.close();
            res.json({ records: filteredData, totals: totals });
        }).catch(err => {
            console.error('[ERROR] Error processing worker customer financial summary:', err);
            db.close();
            res.status(500).json({ error: 'Database error' });
        });
    });
}

module.exports = {
    workerSalesView,
    workerReceiptsView,
    workerAddSalesBatch,
    workerAddReceiptsBatch,
    workerManageCustomers,
    workerEditCustomer,
    workerDeleteCustomer,
    apiAgencyCustomers,
    workerCommandDeck,
    apiWorkerFinancialMetrics,
    apiWorkerAgentLogSubmissions,
    workerAgentRemittances,
    apiWorkerRemittanceLedger,
    workerDailyExpenses,
    workerAddExpense,
    workerAddExpensesBatch,
    apiWorkerExpenses,
    apiWorkerExpensesSummary,
    apiWorkerIncomingWaybills,
    apiWorkerCommitWaybillSalesBatch,
    apiWorkerSellWaybillDirect,
    apiWorkerCementSummaryReport,
    workerQuotationRequests,
    apiWorkerQuotationRequests,
    apiWorkerQuotationRequestDetails,
    apiWorkerUpdateQuotationRequestStatus,
    apiWorkerCustomerBalances,
    apiWorkerMarkWaybillInQueue,
    apiWorkerMarkWaybillAvailable,
    apiWorkerWaitingQueue,
    apiWorkerCustomerFinancialSummary
};
