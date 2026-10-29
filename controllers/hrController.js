const { getDbConnection } = require('../config/database');
const notificationSSE = require('../utils/notificationSSE');
const { getCurrentJalaliMonth, getCurrentJalaliDate, validateJalaliDate, compareJalaliDates, subtractOneJalaliDay, addOneJalaliDay, getDaysInJalaliMonth, t: i18n } = require('../middleware/i18n');
const fs = require('fs');
const path = require('path');
const { validatePdfMagicBytes } = require('../middleware/upload');
const paymentController = require('./paymentController');
const payrollCenterController = require('./payrollCenterController');
const { redirectBack } = require('../middleware/safeRedirect');
const { likeContains } = require('../utils/sqlSafety');

function validateEmployeeExists(db, employee_id, callback) {
    if (!employee_id && employee_id !== 0) {
        return callback(new Error('Employee ID is required.'));
    }
    db.get('SELECT id, employment_status FROM hr_employees WHERE id = ?', [employee_id], (err, employee) => {
        if (err) {
            console.error('validateEmployeeExists DB error:', err);
            return callback(new Error('Employee lookup failed.'));
        }
        if (!employee) return callback(new Error('Employee not found.'));
        if (employee.employment_status !== 'Active') return callback(new Error('Employee is not active.'));
        callback(null, employee);
    });
}

// HR Dashboard
function hrDashboard(req, res) {
    const db = getDbConnection();
    const { getDaysInJalaliMonth } = require('../middleware/i18n');

    const periodType = req.query.periodType || 'monthly';
    const currentJalali = getCurrentJalaliDate();
    const currentParts = currentJalali.split('/');
    const currentYear = parseInt(currentParts[0], 10);
    const currentMonth = parseInt(currentParts[1], 10);
    const currentDay = currentParts[2];

    let periodStart, periodEnd, payrollPeriodPrefix, selectedMonth, selectedYear, selectedStartDate, selectedEndDate;

    if (periodType === 'daily') {
        selectedStartDate = req.query.startDate || '';
        selectedEndDate = req.query.endDate || '';
        if (selectedStartDate && selectedEndDate) {
            periodStart = selectedStartDate;
            periodEnd = selectedEndDate;
        } else {
            periodStart = currentJalali;
            periodEnd = currentJalali;
        }
        const dParts = periodStart.split('/');
        payrollPeriodPrefix = `${dParts[0]}/${dParts[1]}`;
        selectedMonth = currentMonth;
        selectedYear = parseInt(dParts[0], 10);
    } else if (periodType === 'yearly') {
        selectedYear = parseInt(req.query.year, 10) || currentYear;
        selectedMonth = currentMonth;
        periodStart = `${selectedYear}/01/01`;
        periodEnd = `${selectedYear}/12/30`;
        payrollPeriodPrefix = `${selectedYear}`;
        selectedStartDate = '';
        selectedEndDate = '';
    } else {
        selectedMonth = parseInt(req.query.month, 10) || currentMonth;
        selectedYear = parseInt(req.query.year, 10) || currentYear;
        const monthStr = String(selectedMonth).padStart(2, '0');
        periodStart = `${selectedYear}/${monthStr}/01`;
        const daysInMonth = getDaysInJalaliMonth(selectedYear, selectedMonth);
        periodEnd = `${selectedYear}/${monthStr}/${String(daysInMonth).padStart(2, '0')}`;
        payrollPeriodPrefix = `${selectedYear}/${monthStr}`;
        selectedStartDate = '';
        selectedEndDate = '';
    }

    // Data-aware: get available years from actual HR operational data
    db.all(`
        SELECT DISTINCT substr(payroll_period, 1, 4) AS year FROM payroll
        UNION
        SELECT DISTINCT substr(attendance_date, 1, 4) AS year FROM attendance
        UNION
        SELECT DISTINCT substr(start_date, 1, 4) AS year FROM leave_requests
        UNION
        SELECT DISTINCT substr(overtime_date, 1, 4) AS year FROM overtime
        UNION
        SELECT DISTINCT substr(date, 1, 4) AS year FROM salary_advances
        ORDER BY year DESC
    `, (err, yearRows) => {
        const availableYears = (yearRows || []).map(r => parseInt(r.year, 10)).filter(y => !isNaN(y));
        if (availableYears.length === 0) { availableYears.push(currentYear); }

    // Get all HR statistics in a single query to avoid nested callback issues
    db.get(`
        SELECT
            (SELECT COUNT(*) FROM hr_employees) as total_employees,
            (SELECT COUNT(*) FROM hr_employees WHERE employment_status = 'Active') as active_employees,
            (SELECT COUNT(*) FROM departments) as departments,
            (SELECT COUNT(*) FROM leave_requests WHERE status = 'Pending') as pending_leave,
            (SELECT COUNT(*) FROM payroll WHERE payment_status = 'Unpaid') as unpaid_payroll,
            (SELECT COALESCE(SUM(net_salary), 0) FROM payroll WHERE payment_status = 'Unpaid') as unpaid_payroll_amount,
            (SELECT COUNT(*) FROM salary_advances WHERE remaining_balance > 0) as active_advances,
            (SELECT COUNT(*) FROM overtime WHERE status = 'Pending') as pending_overtime,
            (SELECT SUM(net_salary) FROM payroll WHERE substr(payroll_period, 1, ?) = ?) as payroll_this_month,
            (SELECT COUNT(*) FROM attendance WHERE attendance_date BETWEEN ? AND ? AND status = 'Present') as present_in_period,
            (SELECT COUNT(*) FROM attendance WHERE attendance_date BETWEEN ? AND ? AND status = 'Absent') as absent_in_period
    `, [payrollPeriodPrefix.length, payrollPeriodPrefix, periodStart, periodEnd, periodStart, periodEnd], (err, stats) => {
        if (err) {
            console.error('[HR DATABASE ERROR] Dashboard query:', err);
            db.close();
            return res.status(500).send('Database error');
        }
        
        // Get department distribution
        db.all(`
            SELECT d.name as department_name, COUNT(e.id) as employee_count
            FROM departments d
            LEFT JOIN hr_employees e ON d.id = e.department_id
            GROUP BY d.id, d.name
            ORDER BY employee_count DESC
        `, (err, departmentDistribution) => {
            if (err) {
                console.error('[HR DATABASE ERROR] Department distribution query:', err);
                db.close();
                return res.status(500).send('Database error');
            }
            
            // Get leave overview
            db.get(`
                SELECT 
                    (SELECT COUNT(*) FROM leave_requests WHERE status = 'Approved') as approved_leave,
                    (SELECT COUNT(*) FROM leave_requests WHERE status = 'Rejected') as rejected_leave
            `, (err, leaveOverview) => {
                if (err) {
                    console.error('[HR DATABASE ERROR] Leave overview query:', err);
                    db.close();
                    return res.status(500).send('Database error');
                }
                
                // Get recent attendance filtered by period
                db.all(`
                    SELECT a.attendance_date, a.status, e.full_name, e.photo_path
                    FROM attendance a
                    JOIN hr_employees e ON a.employee_id = e.id
                    WHERE a.attendance_date BETWEEN ? AND ?
                    ORDER BY a.attendance_date DESC
                    LIMIT 5
                `, [periodStart, periodEnd], (err, recentAttendance) => {
                    if (err) {
                        console.error('[HR DATABASE ERROR] Recent attendance query:', err);
                        db.close();
                        return res.status(500).send('Database error');
                    }
                    
                    // Get recent leave requests filtered by period (overlapping)
                    db.all(`
                        SELECT lr.start_date, lr.end_date, lr.status, lt.name as leave_type, e.full_name, e.photo_path
                        FROM leave_requests lr
                        LEFT JOIN leave_types lt ON lr.leave_type_id = lt.id
                        JOIN hr_employees e ON lr.employee_id = e.id
                        WHERE lr.start_date <= ? AND lr.end_date >= ?
                        ORDER BY lr.created_at DESC
                        LIMIT 5
                    `, [periodEnd, periodStart], (err, recentLeave) => {
                        if (err) {
                            console.error('[HR DATABASE ERROR] Recent leave query:', err);
                            db.close();
                            return res.status(500).send('Database error');
                        }

                        // Get recent HR activity filtered by period
                        db.all(`
                            SELECT 'employee_created' as activity_type, e.full_name, e.photo_path, e.created_at as timestamp
                            FROM hr_employees e
                            WHERE e.created_at BETWEEN ? AND ?
                            UNION ALL
                            SELECT 'leave_request', e.full_name, e.photo_path, lr.created_at as timestamp
                            FROM leave_requests lr
                            JOIN hr_employees e ON lr.employee_id = e.id
                            WHERE lr.created_at BETWEEN ? AND ?
                            UNION ALL
                            SELECT 'attendance', e.full_name, e.photo_path, a.created_at as timestamp
                            FROM attendance a
                            JOIN hr_employees e ON a.employee_id = e.id
                            WHERE a.created_at BETWEEN ? AND ?
                            UNION ALL
                            SELECT 'salary_advance', e.full_name, e.photo_path, sa.created_at as timestamp
                            FROM salary_advances sa
                            JOIN hr_employees e ON sa.employee_id = e.id
                            WHERE sa.created_at BETWEEN ? AND ?
                            UNION ALL
                            SELECT 'overtime', e.full_name, e.photo_path, o.created_at as timestamp
                            FROM overtime o
                            JOIN hr_employees e ON o.employee_id = e.id
                            WHERE o.created_at BETWEEN ? AND ?
                            ORDER BY timestamp DESC
                            LIMIT 10
                        `, [periodStart, periodEnd, periodStart, periodEnd, periodStart, periodEnd, periodStart, periodEnd, periodStart, periodEnd], (err, recentActivity) => {
                            if (err) {
                                console.error('[HR DATABASE ERROR] Recent activity query:', err);
                                db.close();
                                return res.status(500).send('Database error');
                            }

                            db.close();

                            res.render('hr/dashboard', {
                                total_employees: stats.total_employees || 0,
                                active_employees: stats.active_employees || 0,
                                departments: stats.departments || 0,
                                pending_leave: stats.pending_leave || 0,
                                unpaid_payroll: stats.unpaid_payroll || 0,
                                unpaid_payroll_amount: stats.unpaid_payroll_amount || 0,
                                active_advances: stats.active_advances || 0,
                                pending_overtime: stats.pending_overtime || 0,
                                payroll_this_month: stats.payroll_this_month || 0,
                                present_in_period: stats.present_in_period || 0,
                                absent_in_period: stats.absent_in_period || 0,
                                departmentDistribution: departmentDistribution || [],
                                approved_leave: leaveOverview.approved_leave || 0,
                                rejected_leave: leaveOverview.rejected_leave || 0,
                                recentAttendance: recentAttendance || [],
                                recentLeave: recentLeave || [],
                                recentActivity: recentActivity || [],
                                periodType: periodType,
                                selectedMonth: selectedMonth,
                                selectedYear: selectedYear,
                                selectedStartDate: selectedStartDate,
                                selectedEndDate: selectedEndDate,
                                availableYears: availableYears,
                                currentYear: currentYear,
                                currentMonth: currentMonth,
                                payrollPeriodPrefix: payrollPeriodPrefix,
                                session: req.session
                            });
                        });
                    });
                });
            });
        });
    });
    }); // close year query callback
}

// Employees List
function hrEmployees(req, res) {
    const db = getDbConnection();
    
    // Get all employees with department info
    db.all(`
        SELECT e.*, d.name as department_name 
        FROM hr_employees e 
        LEFT JOIN departments d ON e.department_id = d.id 
        ORDER BY e.created_at DESC
    `, (err, employees) => {
        if (err) {
            db.close();
            return res.status(500).send('Database error');
        }
        
        // Get departments for filter
        db.all('SELECT * FROM departments WHERE active = 1 ORDER BY name ASC', (err, departments) => {
            db.close();
            if (err) {
                return res.status(500).send('Database error');
            }
            
            res.render('hr/employees', {
                employees,
                departments,
                session: req.session
            });
        });
    });
}

// Add Employee
function hrAddEmployee(req, res) {
    const db = getDbConnection();
    
    if (req.method === 'POST') {
        const {
            employee_id,
            full_name,
            father_name,
            date_of_birth,
            gender,
            phone,
            address,
            emergency_contact_name,
            emergency_contact_phone,
            emergency_contact_relationship,
            position,
            department_id,
            hire_date,
            employment_status,
            work_location,
            contract_type,
            payment_method,
            supervisor_id,
            employment_end_date,
            departure_reason,
            salary,
            work_schedule_id
        } = req.body;

        // Validate salary if provided
        let validatedSalary = null;
        if (salary !== undefined && salary !== null && salary !== '') {
            const salaryNum = parseFloat(salary);
            if (isNaN(salaryNum) || salaryNum < 0) {
                req.session.message = { type: 'error', text: res.locals.t('hr.employees.salary_error_non_negative') };
                db.close();
                return res.redirect('/admin/hr/employees/add');
            }
            validatedSalary = salaryNum;
        }

        // Validate work_schedule_id is provided and exists
        if (!work_schedule_id || work_schedule_id === '') {
            req.session.message = { type: 'error', text: res.locals.t('hr.employees.work_schedule_required') };
            db.close();
            return res.redirect('/admin/hr/employees/add');
        }

        const parsedScheduleId = parseInt(work_schedule_id, 10);
        if (isNaN(parsedScheduleId) || parsedScheduleId <= 0) {
            req.session.message = { type: 'error', text: res.locals.t('hr.employees.work_schedule_invalid') };
            db.close();
            return res.redirect('/admin/hr/employees/add');
        }

        // Generate employee_id if not provided
        const finalEmployeeId = employee_id || `EMP-${Date.now()}`;

        // Verify the schedule exists before inserting
        db.get('SELECT id FROM work_schedules WHERE id = ?', [parsedScheduleId], (schedErr, schedule) => {
            if (schedErr || !schedule) {
                req.session.message = { type: 'error', text: res.locals.t('hr.employees.work_schedule_not_found') };
                db.close();
                return res.redirect('/admin/hr/employees/add');
            }

        // Begin transaction
        db.run('BEGIN TRANSACTION', (beginErr) => {
            if (beginErr) {
                console.error('Error beginning transaction:', beginErr);
                req.session.message = { type: 'error', text: 'Database error' };
                db.close();
                return res.redirect('/admin/hr/employees/add');
            }

            db.run(`
                INSERT INTO hr_employees (
                    employee_id, full_name, father_name, date_of_birth, gender, phone, address,
                    emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
                    position, department_id, hire_date, employment_status,
                    supervisor_id, work_location, contract_type, payment_method,
                    employment_end_date, departure_reason, created_by, work_schedule_id, photo_path
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                finalEmployeeId, full_name, father_name, date_of_birth, gender, phone, address,
                emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
                position, department_id || null, hire_date, employment_status || 'Active',
                supervisor_id || null, work_location, contract_type, payment_method,
                employment_end_date || null, departure_reason || null, req.session.username,
                parsedScheduleId, (req.files && req.files.employee_photo && req.files.employee_photo[0]) ? 'uploads/employees/' + req.files.employee_photo[0].filename : null
            ], function(err) {
                if (err) {
                    console.error('Error adding employee:', err);
                    db.run('ROLLBACK', () => {
                        req.session.message = { type: 'error', text: 'Error adding employee' };
                        db.close();
                        return res.redirect('/admin/hr/employees/add');
                    });
                    return;
                }

                const newEmployeeId = this.lastID;

                // Create salary history record if salary was provided
                if (validatedSalary !== null && hire_date) {
                    db.run(`
                        INSERT INTO employee_salary_history (employee_id, basic_salary, allowances, effective_from, effective_to, notes, created_by)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                    `, [newEmployeeId, validatedSalary, 0, hire_date, null, 'Initial salary', req.session.username], (salaryErr) => {
                        if (salaryErr) {
                            console.error('Error adding salary history:', salaryErr);
                            db.run('ROLLBACK', () => {
                                req.session.message = { type: 'error', text: res.locals.t('hr.employees.salary_error_adding') };
                                db.close();
                                return res.redirect('/admin/hr/employees/add');
                            });
                            return;
                        }

                        // Commit transaction and create notification
                        commitAndNotify();
                    });
                } else {
                    // No salary to add, commit and notify
                    commitAndNotify();
                }

                function commitAndNotify() {
                    // C4.2 CORRECTION: Process document uploads BEFORE commit
                    // so we can ROLLBACK if any document fails validation
                    processDocumentUploads(db, newEmployeeId, req, res, full_name, function(docErr) {
                        if (docErr) {
                            db.run('ROLLBACK', function() {
                                // Clean up any files multer already stored
                                if (docErr.storedFiles) {
                                    docErr.storedFiles.forEach(function(f) {
                                        try { fs.unlinkSync(f); } catch(e) {}
                                    });
                                }
                                req.session.message = { type: 'error', text: docErr.message };
                                db.close();
                                return res.redirect('/admin/hr/employees/add');
                            });
                            return;
                        }

                        // All documents validated and records inserted - commit
                        db.run('COMMIT', (commitErr) => {
                            if (commitErr) {
                                console.error('Error committing transaction:', commitErr);
                                db.run('ROLLBACK', () => {
                                    req.session.message = { type: 'error', text: 'Database error during save' };
                                    db.close();
                                    return res.redirect('/admin/hr/employees/add');
                                });
                                return;
                            }

                            // Create notification
                            const notificationMessage = `New employee "${full_name}" added by ${req.session.username}`;
                            db.run(`
                                INSERT INTO admin_notifications (type, message, related_record_id, related_record_type, created_by, recipient, is_read, created_at)
                                VALUES (?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
                            `, ['hr_employee_created', notificationMessage, newEmployeeId, 'employee', req.session.username, req.session.username], (notifErr) => {
                                if (notifErr) {
                                    console.error('Error creating notification:', notifErr);
                                } else {
                                    notificationSSE.broadcast({
                                        id: newEmployeeId,
                                        type: 'hr_employee_created',
                                        message: notificationMessage,
                                        related_record_id: newEmployeeId,
                                        related_record_type: 'employee',
                                        created_by: req.session.username,
                                        recipient: req.session.username,
                                        is_read: 0,
                                        created_at: new Date().toISOString()
                                    });
                                }

                                req.session.message = { type: 'success', text: 'Employee added successfully!' };
                                db.close();
                                res.redirect('/admin/hr/employees');
                            });
                        });
                    });
                }
            });
        });
        }); // close db.get schedule verification
    } else {
        // GET request - show add form
        db.all('SELECT * FROM departments WHERE active = 1 ORDER BY name ASC', (err, departments) => {
            if (err) {
                db.close();
                return res.status(500).send('Database error');
            }

            db.all('SELECT * FROM work_schedules ORDER BY name ASC', (schedErr, workSchedules) => {
                db.close();
                res.render('hr/employee-add', {
                    departments,
                    workSchedules: workSchedules || [],
                    session: req.session
                });
            });
        });
    }
}

// Edit Employee
function hrEditEmployee(req, res) {
    const db = getDbConnection();
    const employeeId = req.params.id;
    
    if (req.method === 'POST') {
        const {
            full_name,
            father_name,
            date_of_birth,
            gender,
            phone,
            address,
            emergency_contact_name,
            emergency_contact_phone,
            emergency_contact_relationship,
            position,
            department_id,
            employment_status,
            supervisor_id,
            work_location,
            contract_type,
            payment_method,
            employment_end_date,
            departure_reason,
            salary,
            salary_effective_date,
            work_schedule_id
        } = req.body;

        // Validate salary if provided
        let validatedSalary = null;
        if (salary !== undefined && salary !== null && salary !== '') {
            const salaryNum = parseFloat(salary);
            if (isNaN(salaryNum) || salaryNum < 0) {
                req.session.message = { type: 'error', text: res.locals.t('hr.employees.salary_error_non_negative') };
                db.close();
                return res.redirect(`/admin/hr/employees/${employeeId}/edit`);
            }
            validatedSalary = salaryNum;
        }

        // Validate effective date if provided with salary
        let validatedEffectiveDate = null;
        if (validatedSalary !== null && salary_effective_date) {
            const dateRegex = /^(\d{4})\/(\d{2})\/(\d{2})$/;
            const match = salary_effective_date.match(dateRegex);
            if (!match) {
                req.session.message = { type: 'error', text: res.locals.t('hr.employees.salary_error_date_format') };
                db.close();
                return res.redirect(`/admin/hr/employees/${employeeId}/edit`);
            }
            const year = parseInt(match[1], 10);
            const month = parseInt(match[2], 10);
            const day = parseInt(match[3], 10);
            if (!validateJalaliDate(year, month, day)) {
                req.session.message = { type: 'error', text: res.locals.t('hr.employees.salary_error_invalid_date') };
                db.close();
                return res.redirect(`/admin/hr/employees/${employeeId}/edit`);
            }
            validatedEffectiveDate = salary_effective_date;
        }

            // Get employee hire date for validation
        db.get('SELECT hire_date, photo_path FROM hr_employees WHERE id = ?', [employeeId], (err, employeeData) => {
            if (err) {
                console.error('Error fetching employee:', err);
                req.session.message = { type: 'error', text: 'Database error' };
                db.close();
                return res.redirect(`/admin/hr/employees/${employeeId}/edit`);
            }

            if (!employeeData) {
                req.session.message = { type: 'error', text: 'Employee not found' };
                db.close();
                return res.redirect(`/admin/hr/employees/${employeeId}/edit`);
            }

            const hireDate = employeeData.hire_date;
            const oldPhotoPath = employeeData.photo_path;

            // Get current salary history
            db.get(`
                SELECT * FROM employee_salary_history
                WHERE employee_id = ?
                AND (effective_to IS NULL OR effective_to >= ?)
                ORDER BY effective_from DESC
                LIMIT 1
            `, [employeeId, getCurrentJalaliDate()], (err, currentSalary) => {
                if (err) {
                    console.error('Error fetching current salary:', err);
                    req.session.message = { type: 'error', text: 'Database error' };
                    db.close();
                    return res.redirect(`/admin/hr/employees/${employeeId}/edit`);
                }

                // Handle salary changes with validation
                if (validatedSalary !== null) {
                    const currentBasicSalary = currentSalary ? currentSalary.basic_salary : null;
                    const effectiveDate = validatedEffectiveDate || getCurrentJalaliDate();

                    // If salary changed or no previous salary exists
                    if (currentBasicSalary === null || currentBasicSalary !== validatedSalary) {
                        // Validate effective date against hire date
                        const effDateParts = effectiveDate.split('/').map(Number);
                        const hireDateParts = hireDate.split('/').map(Number);
                        const hireDateObj = { year: hireDateParts[0], month: hireDateParts[1], day: hireDateParts[2] };
                        const effDateObj = { year: effDateParts[0], month: effDateParts[1], day: effDateParts[2] };

                        if (compareJalaliDates(effDateObj, hireDateObj) < 0) {
                            req.session.message = { type: 'error', text: res.locals.t('hr.employees.salary_error_before_hire') };
                            db.close();
                            return res.redirect(`/admin/hr/employees/${employeeId}/edit`);
                        }

                        // Validate against current salary if exists
                        if (currentSalary) {
                            const currentFromDateParts = currentSalary.effective_from.split('/').map(Number);
                            const currentFromDateObj = { year: currentFromDateParts[0], month: currentFromDateParts[1], day: currentFromDateParts[2] };

                            // Reject if effective date is before current salary effective_from
                            if (compareJalaliDates(effDateObj, currentFromDateObj) < 0) {
                                req.session.message = { type: 'error', text: res.locals.t('hr.employees.salary_error_conflict') };
                                db.close();
                                return res.redirect(`/admin/hr/employees/${employeeId}/edit`);
                            }

                            // Reject if effective date is the same as current salary effective_from
                            if (compareJalaliDates(effDateObj, currentFromDateObj) === 0) {
                                req.session.message = { type: 'error', text: res.locals.t('hr.employees.salary_error_same_date') };
                                db.close();
                                return res.redirect(`/admin/hr/employees/${employeeId}/edit`);
                            }
                        }

                        // Begin transaction for salary change
                        db.run('BEGIN TRANSACTION', (beginErr) => {
                            if (beginErr) {
                                console.error('Error beginning transaction:', beginErr);
                                req.session.message = { type: 'error', text: 'Database error' };
                                db.close();
                                return res.redirect(`/admin/hr/employees/${employeeId}/edit`);
                            }

                            // Update employee record
                            db.run(`
                                UPDATE hr_employees SET
                                    full_name = ?, father_name = ?, date_of_birth = ?, gender = ?, phone = ?, address = ?,
                                    emergency_contact_name = ?, emergency_contact_phone = ?, emergency_contact_relationship = ?,
                                    position = ?, department_id = ?, employment_status = ?,
                                    supervisor_id = ?, work_location = ?, contract_type = ?, payment_method = ?,
                                    employment_end_date = ?, departure_reason = ?, work_schedule_id = ?,
                                    photo_path = ?,
                                    updated_at = CURRENT_TIMESTAMP
                                WHERE id = ?
                            `, [
                                full_name, father_name, date_of_birth, gender, phone, address,
                                emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
                                position, department_id || null, employment_status,
                                supervisor_id || null, work_location, contract_type, payment_method,
                                employment_end_date || null, departure_reason, work_schedule_id || null,
                                req.file ? 'uploads/employees/' + req.file.filename : (oldPhotoPath || null),
                                employeeId
                            ], (updateErr) => {
                                if (updateErr) {
                                    console.error('Error updating employee:', updateErr);
                                    db.run('ROLLBACK', () => {
                                        req.session.message = { type: 'error', text: 'Error updating employee' };
                                        db.close();
                                        return res.redirect(`/admin/hr/employees/${employeeId}/edit`);
                                    });
                                    return;
                                }

                                // Close previous salary record if exists
                                if (currentSalary) {
                                    const prevDateParts = effectiveDate.split('/').map(Number);
                                    const prevDay = subtractOneJalaliDay(prevDateParts[0], prevDateParts[1], prevDateParts[2]);
                                    const prevDateStr = `${prevDay.year}/${prevDay.month.toString().padStart(2, '0')}/${prevDay.day.toString().padStart(2, '0')}`;

                                    db.run(`
                                        UPDATE employee_salary_history
                                        SET effective_to = ?
                                        WHERE id = ?
                                    `, [prevDateStr, currentSalary.id], (closeErr) => {
                                        if (closeErr) {
                                            console.error('Error closing previous salary record:', closeErr);
                                            db.run('ROLLBACK', () => {
                                                req.session.message = { type: 'error', text: res.locals.t('hr.employees.salary_error_updating') };
                                                db.close();
                                                return res.redirect(`/admin/hr/employees/${employeeId}/edit`);
                                            });
                                            return;
                                        }
                                        insertNewSalary();
                                    });
                                } else {
                                    insertNewSalary();
                                }

                                function insertNewSalary() {
                                    db.run(`
                                        INSERT INTO employee_salary_history (employee_id, basic_salary, allowances, effective_from, effective_to, notes, created_by)
                                        VALUES (?, ?, ?, ?, ?, ?, ?)
                                    `, [employeeId, validatedSalary, 0, effectiveDate, null, 'Salary update', req.session.username], (insertErr) => {
                                        if (insertErr) {
                                            console.error('Error inserting new salary record:', insertErr);
                                            db.run('ROLLBACK', () => {
                                                req.session.message = { type: 'error', text: res.locals.t('hr.employees.salary_error_creating') };
                                                db.close();
                                                return res.redirect(`/admin/hr/employees/${employeeId}/edit`);
                                            });
                                            return;
                                        }

                                        // Commit transaction
                                        db.run('COMMIT', (commitErr) => {
                                            if (commitErr) {
                                                console.error('Error committing transaction:', commitErr);
                                                db.run('ROLLBACK', () => {
                                                    req.session.message = { type: 'error', text: 'Database error during save' };
                                                    db.close();
                                                    return res.redirect(`/admin/hr/employees/${employeeId}/edit`);
                                                });
                                                return;
                                            }

                                            // Delete old photo file if a new one was uploaded
                                            if (req.file && oldPhotoPath) {
                                                const oldFilePath = path.join(__dirname, '..', 'public', oldPhotoPath);
                                                if (fs.existsSync(oldFilePath)) {
                                                    fs.unlinkSync(oldFilePath);
                                                }
                                            }

                                            req.session.message = { type: 'success', text: 'Employee updated successfully!' };
                                            db.close();
                                            res.redirect('/admin/hr/employees');
                                        });
                                    });
                                }  // closes insertNewSalary function definition
            });  // closes UPDATE callback
        });  // closes BEGIN TRANSACTION callback
    } else {
                        // Salary unchanged - update employee without transaction
                        db.run(`
                            UPDATE hr_employees SET
                                full_name = ?, father_name = ?, date_of_birth = ?, gender = ?, phone = ?, address = ?,
                                emergency_contact_name = ?, emergency_contact_phone = ?, emergency_contact_relationship = ?,
                                position = ?, department_id = ?, employment_status = ?,
                                supervisor_id = ?, work_location = ?, contract_type = ?, payment_method = ?,
                                employment_end_date = ?, departure_reason = ?, work_schedule_id = ?,
                                photo_path = ?,
                                updated_at = CURRENT_TIMESTAMP
                            WHERE id = ?
                        `, [
                            full_name, father_name, date_of_birth, gender, phone, address,
                            emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
                            position, department_id || null, employment_status,
                            supervisor_id || null, work_location, contract_type, payment_method,
                            employment_end_date || null, departure_reason, work_schedule_id || null,
                            req.file ? 'uploads/employees/' + req.file.filename : (oldPhotoPath || null),
                            employeeId
                        ], (updateErr) => {
                            if (updateErr) {
                                console.error('Error updating employee:', updateErr);
                                req.session.message = { type: 'error', text: 'Error updating employee' };
                                db.close();
                                return res.redirect(`/admin/hr/employees/${employeeId}/edit`);
                            }

                            // Delete old photo file if a new one was uploaded
                            if (req.file && oldPhotoPath) {
                                const oldFilePath = path.join(__dirname, '..', 'public', oldPhotoPath);
                                if (fs.existsSync(oldFilePath)) {
                                    fs.unlinkSync(oldFilePath);
                                }
                            }

                            req.session.message = { type: 'success', text: 'Employee updated successfully!' };
                            db.close();
                            res.redirect('/admin/hr/employees');
                        });
                    }
                } else {
                    // No salary provided - update employee without transaction
                    db.run(`
                        UPDATE hr_employees SET
                            full_name = ?, father_name = ?, date_of_birth = ?, gender = ?, phone = ?, address = ?,
                            emergency_contact_name = ?, emergency_contact_phone = ?, emergency_contact_relationship = ?,
                            position = ?, department_id = ?, employment_status = ?,
                            supervisor_id = ?, work_location = ?, contract_type = ?, payment_method = ?,
                            employment_end_date = ?, departure_reason = ?, work_schedule_id = ?,
                            photo_path = ?,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                    `, [
                        full_name, father_name, date_of_birth, gender, phone, address,
                        emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
                        position, department_id || null, employment_status,
                        supervisor_id || null, work_location, contract_type, payment_method,
                        employment_end_date || null, departure_reason, work_schedule_id || null,
                        req.file ? 'uploads/employees/' + req.file.filename : (oldPhotoPath || null),
                        employeeId
                    ], (updateErr) => {
                        if (updateErr) {
                            console.error('Error updating employee:', updateErr);
                            req.session.message = { type: 'error', text: 'Error updating employee' };
                            db.close();
                            return res.redirect(`/admin/hr/employees/${employeeId}/edit`);
                        }

                        // Delete old photo file if a new one was uploaded
                        if (req.file && oldPhotoPath) {
                            const oldFilePath = path.join(__dirname, '..', 'public', oldPhotoPath);
                            if (fs.existsSync(oldFilePath)) {
                                fs.unlinkSync(oldFilePath);
                            }
                        }

                        req.session.message = { type: 'success', text: 'Employee updated successfully!' };
                        db.close();
                        res.redirect('/admin/hr/employees');
                    });
                }
            }); // close db.get currentSalary
        }); // close db.get hireDate
    } else {
        // GET request - show edit form
        db.get('SELECT * FROM hr_employees WHERE id = ?', [employeeId], (err, employee) => {
            if (err) {
                db.close();
                return res.status(500).send('Database error');
            }

            if (!employee) {
                db.close();
                return res.status(404).send('Employee not found');
            }

            // Get current salary
            db.get(`
                SELECT * FROM employee_salary_history
                WHERE employee_id = ?
                AND (effective_to IS NULL OR effective_to >= ?)
                ORDER BY effective_from DESC
                LIMIT 1
            `, [employeeId, getCurrentJalaliDate()], (err, currentSalary) => {
                if (err) {
                    console.error('Error fetching current salary:', err);
                }

                db.all('SELECT * FROM departments WHERE active = 1 ORDER BY name ASC', (err, departments) => {
                    if (err) {
                        db.close();
                        return res.status(500).send('Database error');
                    }

                    db.all('SELECT id, full_name FROM hr_employees WHERE employment_status = "Active" AND id != ? ORDER BY full_name ASC', [employeeId], (err, supervisors) => {
                        if (err) {
                            db.close();
                            return res.status(500).send('Database error');
                        }

                        db.all('SELECT * FROM work_schedules ORDER BY name ASC', (schedErr, workSchedules) => {
                            if (schedErr) {
                                console.error('Error fetching work schedules:', schedErr);
                            }

                            // C4.3: Fetch employee documents grouped by category
                            db.all(`
                                SELECT ed.*, dt.name as document_type_name
                                FROM employee_documents ed
                                LEFT JOIN document_types dt ON ed.document_type_id = dt.id
                                WHERE ed.employee_id = ?
                                ORDER BY ed.document_type_id ASC
                            `, [employeeId], (docErr, documents) => {
                                db.close();

                                // C4.3: Categorize documents
                                var docCategories = {
                                    tazkira_passport: null,
                                    cv: null,
                                    degrees_certificates: null,
                                    other: null
                                };
                                if (!docErr && documents && documents.length > 0) {
                                    documents.forEach(function(doc) {
                                        var typeId = doc.document_type_id;
                                        if (typeId === 4 || typeId === 8) {
                                            if (!docCategories.tazkira_passport) docCategories.tazkira_passport = doc;
                                        } else if (typeId === 7) {
                                            if (!docCategories.cv) docCategories.cv = doc;
                                        } else if (typeId === 2 || typeId === 5) {
                                            if (!docCategories.degrees_certificates) docCategories.degrees_certificates = doc;
                                        } else if (typeId === 3) {
                                            if (!docCategories.other) docCategories.other = doc;
                                        }
                                    });
                                }

                                res.render('hr/employee-edit', {
                                    employee,
                                    currentSalary: currentSalary || null,
                                    departments,
                                    supervisors,
                                    workSchedules: workSchedules || [],
                                    docCategories: docCategories,
                                    session: req.session
                                });
                            });
                        });
                    });
                });
            });
        });
    }
}

// Employee Profile
function hrEmployeeProfile(req, res) {
    const db = getDbConnection();
    const employeeId = req.params.id;
    
    db.get(`
        SELECT e.*, d.name as department_name, s.full_name as supervisor_name 
        FROM hr_employees e 
        LEFT JOIN departments d ON e.department_id = d.id 
        LEFT JOIN hr_employees s ON e.supervisor_id = s.id 
        WHERE e.id = ?
    `, [employeeId], (err, employee) => {
        if (err) {
            db.close();
            return res.status(500).send('Database error');
        }
        
        if (!employee) {
            db.close();
            return res.status(404).send('Employee not found');
        }
        
        // Get salary history
        db.all('SELECT * FROM employee_salary_history WHERE employee_id = ? ORDER BY effective_from DESC', [employeeId], (err, salaryHistory) => {
            if (err) {
                db.close();
                return res.status(500).send('Database error');
            }
            
            // Get payroll records
            db.all('SELECT * FROM payroll WHERE employee_id = ? ORDER BY payroll_period DESC', [employeeId], (err, payrollRecords) => {
                if (err) {
                    db.close();
                    return res.status(500).send('Database error');
                }
                
                // Get attendance records
                db.all('SELECT * FROM attendance WHERE employee_id = ? ORDER BY attendance_date DESC LIMIT 30', [employeeId], (err, attendanceRecords) => {
                    if (err) {
                        db.close();
                        return res.status(500).send('Database error');
                    }
                    
                    // Get leave requests
                    db.all(`
                        SELECT lr.*, lt.name as leave_type_name 
                        FROM leave_requests lr 
                        LEFT JOIN leave_types lt ON lr.leave_type_id = lt.id 
                        WHERE lr.employee_id = ? 
                        ORDER BY lr.created_at DESC
                    `, [employeeId], (err, leaveRequests) => {
                        if (err) {
                            db.close();
                            return res.status(500).send('Database error');
                        }
                        
                        // Get leave balances
                        db.all('SELECT * FROM leave_balances WHERE employee_id = ?', [employeeId], (err, leaveBalances) => {
                            if (err) {
                                db.close();
                                return res.status(500).send('Database error');
                            }
                            
                            // Get documents
                            db.all(`
                                SELECT ed.*, dt.name as document_type_name 
                                FROM employee_documents ed 
                                LEFT JOIN document_types dt ON ed.document_type_id = dt.id 
                                WHERE ed.employee_id = ? 
                                ORDER BY ed.created_at DESC
                            `, [employeeId], (err, documents) => {
                                if (err) {
                                    db.close();
                                    return res.status(500).send('Database error');
                                }
                                
                                // Get overtime records
                                db.all('SELECT * FROM overtime WHERE employee_id = ? ORDER BY overtime_date DESC LIMIT 10', [employeeId], (err, overtimeRecords) => {
                                    if (err) {
                                        db.close();
                                        return res.status(500).send('Database error');
                                    }
                                    
                                    // Get salary advances
                                    db.all('SELECT * FROM salary_advances WHERE employee_id = ? ORDER BY created_at DESC LIMIT 10', [employeeId], (err, advances) => {
                                        if (err) {
                                            db.close();
                                            return res.status(500).send('Database error');
                                        }
                                        
                                        // Get deductions
                                        db.all('SELECT * FROM salary_deductions WHERE employee_id = ? ORDER BY deduction_date DESC LIMIT 10', [employeeId], (err, deductions) => {
                                            if (err) {
                                                db.close();
                                                return res.status(500).send('Database error');
                                            }
                                            
                                            // Get performance reviews
                                            db.all('SELECT * FROM performance_reviews WHERE employee_id = ? ORDER BY review_date DESC LIMIT 10', [employeeId], (err, performanceReviews) => {
                                                if (err) {
                                                    db.close();
                                                    return res.status(500).send('Database error');
                                                }
                                                
                                                // Get disciplinary records
                                                db.all('SELECT * FROM disciplinary_records WHERE employee_id = ? ORDER BY record_date DESC LIMIT 10', [employeeId], (err, disciplinaryRecords) => {
                                                    if (err) {
                                                        db.close();
                                                        return res.status(500).send('Database error');
                                                    }
                                                    
                                                    db.close();
                                                    
                                                    res.render('hr/employee-profile', {
                                                        employee,
                                                        salaryHistory,
                                                        payrollRecords,
                                                        attendanceRecords,
                                                        leaveRequests,
                                                        leaveBalances,
                                                        documents,
                                                        overtimeRecords,
                                                        advances,
                                                        deductions,
                                                        performanceReviews,
                                                        disciplinaryRecords,
                                                        session: req.session
                                                    });
                                                });
                                            });
                                        });
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    });
}

// Departments Management
function hrDepartments(req, res) {
    const db = getDbConnection();
    
    if (req.method === 'POST') {
        const { name, description } = req.body;
        
        db.run('INSERT INTO departments (name, description) VALUES (?, ?)', [name, description], (err) => {
            if (err) {
                console.error('Error adding department:', err);
                req.session.message = { type: 'error', text: 'Error adding department' };
            } else {
                req.session.message = { type: 'success', text: 'Department added successfully!' };
            }
            
            db.close();
            res.redirect('/admin/hr/departments');
        });
    } else {
        db.all('SELECT * FROM departments ORDER BY name ASC', (err, departments) => {
            db.close();
            if (err) {
                return res.status(500).send('Database error');
            }
            
            res.render('hr/departments', {
                departments,
                session: req.session
            });
        });
    }
}

// Delete Department
function hrDeleteDepartment(req, res) {
    const db = getDbConnection();
    const departmentId = req.params.id;
    
    // Check if department has employees
    db.get('SELECT COUNT(*) as count FROM hr_employees WHERE department_id = ?', [departmentId], (err, row) => {
        if (err) {
            db.close();
            return res.status(500).send('Database error');
        }
        
        if (row.count > 0) {
            db.close();
            req.session.message = { type: 'error', text: 'Cannot delete department with employees. Please reassign employees first.' };
            return res.redirect('/admin/hr/departments');
        }
        
        db.run('DELETE FROM departments WHERE id = ?', [departmentId], (err) => {
            if (err) {
                console.error('Error deleting department:', err);
                req.session.message = { type: 'error', text: 'Error deleting department' };
            } else {
                req.session.message = { type: 'success', text: 'Department deleted successfully!' };
            }
            
            db.close();
            res.redirect('/admin/hr/departments');
        });
    });
}

// Salary History Management
function hrSalaryHistory(req, res) {
    const db = getDbConnection();
    const employeeId = req.params.id;
    
    if (req.method === 'POST') {
        const { basic_salary, allowances, effective_from, effective_to, notes } = req.body;
        
        validateEmployeeExists(db, employeeId, (empErr) => {
            if (empErr) {
                db.close();
                req.session.message = { type: 'error', text: empErr.message };
                return res.redirect(`/admin/hr/employees/${employeeId}`);
            }
        
        const parsedBasicSalary = parseFloat(basic_salary);
        if (isNaN(parsedBasicSalary) || parsedBasicSalary < 0) {
            req.session.message = { type: 'error', text: 'Invalid basic salary. Must be a non-negative number.' };
            db.close();
            return res.redirect(`/admin/hr/employees/${employeeId}`);
        }
        
        const parsedAllowances = allowances !== undefined && allowances !== null && allowances !== '' ? parseFloat(allowances) : 0;
        if (isNaN(parsedAllowances) || parsedAllowances < 0) {
            req.session.message = { type: 'error', text: 'Invalid allowances. Must be a non-negative number.' };
            db.close();
            return res.redirect(`/admin/hr/employees/${employeeId}`);
        }
        
        // Validate date format YYYY/MM/DD
        const dateRegex = /^\d{4}\/\d{2}\/\d{2}$/;
        if (!effective_from || !dateRegex.test(effective_from)) {
            req.session.message = { type: 'error', text: res.locals.t('hr.employees.date_format_error') };
            db.close();
            return res.redirect(`/admin/hr/employees/${employeeId}`);
        }
        
        if (effective_to && !dateRegex.test(effective_to)) {
            req.session.message = { type: 'error', text: res.locals.t('hr.employees.date_format_error') };
            db.close();
            return res.redirect(`/admin/hr/employees/${employeeId}`);
        }
        
        const newEffectiveTo = effective_to || null;
        
        db.all('SELECT effective_from, effective_to FROM employee_salary_history WHERE employee_id = ?', [employeeId], (err, existingRecords) => {
            if (err) {
                console.error('Error checking salary history:', err);
                req.session.message = { type: 'error', text: 'Error checking salary history.' };
                db.close();
                return res.redirect(`/admin/hr/employees/${employeeId}`);
            }
            
            for (const record of existingRecords) {
                const existingStart = record.effective_from;
                const existingEnd = record.effective_to;
                
                const newStartsBeforeOrAtExistingEnd = existingEnd === null || effective_from <= existingEnd;
                const newEndsAfterOrAtExistingStart = newEffectiveTo === null || newEffectiveTo >= existingStart;
                
                if (newStartsBeforeOrAtExistingEnd && newEndsAfterOrAtExistingStart) {
                    req.session.message = { type: 'error', text: 'Salary period overlaps with an existing record (' + existingStart + ' to ' + (existingEnd || 'present') + '). Adjust the dates to avoid overlap.' };
                    db.close();
                    return res.redirect(`/admin/hr/employees/${employeeId}`);
                }
            }
            
            db.run(`
                INSERT INTO employee_salary_history (employee_id, basic_salary, allowances, effective_from, effective_to, notes, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [employeeId, parsedBasicSalary, parsedAllowances, effective_from, newEffectiveTo, notes, req.session.username], (err) => {
                if (err) {
                    console.error('Error adding salary history:', err);
                    req.session.message = { type: 'error', text: 'Error adding salary history' };
                } else {
                    req.session.message = { type: 'success', text: 'Salary history added successfully!' };
                }
                
            db.close();
            res.redirect(`/admin/hr/employees/${employeeId}`);
            });
        });
        }); // close validateEmployeeExists
    } else {
        db.all('SELECT * FROM employee_salary_history WHERE employee_id = ? ORDER BY effective_from DESC', [employeeId], (err, salaryHistory) => {
            db.close();
            if (err) {
                return res.status(500).send('Database error');
            }
            
            res.render('hr/salary-history', {
                employeeId,
                salaryHistory,
                session: req.session
            });
        });
    }
}

// Payroll List
// HR-34: simple employee-month table — merge finalized payments with salary obligations.
// paid = money actually paid (finalized payment), owed = salary still to pay (open obligation).
// Every active employee also gets a row for the current period, so not-paid people
// (no obligation opened yet, nothing paid) still show up under the Unpaid filter.
function buildMonthRows(oblRows, payRows, statusFilter, activeEmployees, targetMonth) {
    const byKey = new Map();
    for (const o of oblRows) {
        const key = o.employee_id + '|' + String(o.earning_month || '').slice(0, 7);
        byKey.set(key, {
            employee_id: o.employee_id,
            name: o.emp_name || '',
            month: String(o.earning_month || '').slice(0, 7),
            paid: Number(o.salary_paid) || 0,
            owed: Number(o.salary_earned || 0) - Number(o.salary_paid || 0),
            status: o.status === 'PAID' ? 'PAID' : (o.status === 'PARTIAL' ? 'PARTIAL' : 'OPEN'),
            date: '',
            serial: ''
        });
    }
    for (const p of payRows) {
        const key = p.employee_id + '|' + String(p.period_month || '').slice(0, 7);
        const existing = byKey.get(key);
        if (existing) {
            if (!existing.date) {
                existing.date = p.payment_date || '';
                existing.serial = p.payment_serial || '';
            }
        } else {
            byKey.set(key, {
                employee_id: p.employee_id,
                name: p.employee_name || '',
                month: String(p.period_month || '').slice(0, 7),
                paid: Number(p.net_cash_paid) || 0,
                owed: 0,
                status: 'PAID',
                date: p.payment_date || '',
                serial: p.payment_serial || ''
            });
        }
    }
    const tMonth = String(targetMonth || '').slice(0, 7);
    if (tMonth) {
        for (const emp of (activeEmployees || [])) {
            const key = emp.id + '|' + tMonth;
            if (!byKey.has(key)) {
                byKey.set(key, {
                    employee_id: emp.id,
                    name: emp.full_name || '',
                    month: tMonth,
                    paid: 0,
                    owed: 0,
                    status: 'OPEN',
                    date: '',
                    serial: ''
                });
            }
        }
    }
    let rows = Array.from(byKey.values());
    if (statusFilter === 'paid') {
        rows = rows.filter(r => r.status === 'PAID');
    } else if (statusFilter === 'unpaid') {
        rows = rows.filter(r => r.status !== 'PAID');
    }
    rows.sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : String(a.name).localeCompare(String(b.name))));
    return rows;
}

function hrPayroll(req, res) {
    const db = getDbConnection();
    let { month, year, status, employee_id } = req.query;
    const centerPeriodRaw = req.query.period;
    const centerPeriodValid = typeof centerPeriodRaw === 'string' && paymentController._internals.validatePeriodMonth(centerPeriodRaw);
    const centerPeriod = centerPeriodValid ? centerPeriodRaw : paymentController._internals.defaultMonth();
    if (centerPeriodValid) {
        month = centerPeriod.slice(5, 7);
        year = centerPeriod.slice(0, 4);
    }
    
    let query = `
        SELECT p.*, e.full_name, e.employee_id, e.position, e.photo_path, d.name as department_name 
        FROM payroll p 
        LEFT JOIN hr_employees e ON p.employee_id = e.id 
        LEFT JOIN departments d ON e.department_id = d.id
    `;
    const params = [];
    
    if (employee_id) {
        query += ` WHERE p.employee_id = ?`;
        params.push(employee_id);
    }
    
    if (month) {
        query += employee_id ? ` AND payroll_period LIKE ? ESCAPE '\\'` : ` WHERE payroll_period LIKE ? ESCAPE '\\'`;
        params.push(likeContains('/' + month));
    }
    
    if (status) {
        query += (employee_id || month) ? ` AND payment_status = ?` : ` WHERE payment_status = ?`;
        params.push(status);
    }
    
    query += ' ORDER BY p.payroll_period DESC, e.full_name ASC';
    
    db.all(query, params, (err, payrollRecords) => {
        if (err) {
            db.close();
            return res.status(500).send('Database error');
        }
        
        // HR-34: simple employee-month table — paid = finalized payment, not paid = open obligation
        const empNum = /^\d+$/.test(String(employee_id || '')) ? Number(employee_id) : null;
        const statusNorm = String(status || '').toLowerCase();
        const monthStatusFilter = statusNorm === 'paid' ? 'paid' : (statusNorm === 'unpaid' ? 'unpaid' : 'all');
        const oblSql = 'SELECT o.employee_id, o.earning_month, o.salary_earned, o.salary_paid, o.status, e.full_name AS emp_name FROM salary_obligation o LEFT JOIN hr_employees e ON e.id = o.employee_id' +
            (empNum ? ' WHERE o.employee_id = ?' : '') +
            ' ORDER BY o.earning_month DESC, e.full_name ASC';
        const paySql = "SELECT p.id, p.employee_id, p.employee_name, p.period_month, p.payment_date, p.net_cash_paid, p.payment_serial FROM payment p WHERE p.status = 'FINALIZED'" +
            (empNum ? ' AND p.employee_id = ?' : '') +
            ' ORDER BY p.period_month DESC, p.id DESC';
        const empSql = "SELECT id, full_name FROM hr_employees WHERE employment_status = 'Active' ORDER BY full_name ASC";
        const monthFilterParams = empNum ? [empNum] : [];
        db.all(oblSql, monthFilterParams, (errObl, oblRows) => {
            db.all(paySql, monthFilterParams, (errPay, payRows) => {
                db.all(empSql, [], (errEmp, empRows) => {
                    const employeeList = errEmp ? [] : empRows;
                    const rowEmployees = employeeList.filter(e => !empNum || Number(e.id) === empNum);
                    const monthRows = buildMonthRows(errObl ? [] : oblRows, errPay ? [] : payRows,
                        monthStatusFilter, rowEmployees, centerPeriod);
                    let contextEmployee = null;
                    if (employee_id) {
                        db.get('SELECT * FROM hr_employees WHERE id = ?', [employee_id], (err, emp) => {
                            if (err) {
                                db.close();
                                return res.status(500).send('Database error');
                            }

                            if (!emp) {
                                db.close();
                                return res.status(404).send('Employee not found');
                            }

                            contextEmployee = emp;
                            let center = null;
                            try {
                                center = payrollCenterController.buildCenterContext(null, { employeeId: emp.id, period: centerPeriod });
                            } catch (e) {
                                center = null;
                            }
                            db.close();

                            res.render('hr/payroll', {
                                center,
                                payrollRecords,
                                monthRows,
                                employeeList,
                                filters: { month, year, status, employee_id },
                                contextEmployee,
                                session: req.session
                            });
                        });
                    } else {
                        let center = null;
                        try {
                            center = payrollCenterController.buildCenterContext(null, { employeeId: null, period: centerPeriod });
                        } catch (e) {
                            center = null;
                        }
                        db.close();

                        res.render('hr/payroll', {
                            center,
                            payrollRecords,
                            monthRows,
                            employeeList,
                            filters: { month, year, status, employee_id },
                            contextEmployee,
                            session: req.session
                        });
                    }
                });
            });
        });
    });
}

// Boolean coercion helper for form checkbox values
// HTML checkboxes send "1" (checked) or undefined (unchecked)
// Hidden fields send "true" or "false" strings
function toBool(val) {
    return val === true || val === 'true' || val === '1' || val === 'on';
}

// Calculate Payroll for a Single Employee (Read-Only Helper)
// This function performs all payroll calculations without database writes
// Returns calculated values via callback
function calculateEmployeePayroll(db, emp, periodStart, periodEnd, periodEndDays, include_overtime, include_deductions, include_advances, callback) {
    // Normalize boolean flags from form values
    include_overtime = toBool(include_overtime);
    include_deductions = toBool(include_deductions);
    include_advances = toBool(include_advances);
    const { getDaysInJalaliMonth, validateJalaliDate, compareJalaliDates } = require('../middleware/i18n');
    
    // Initialize result structure
    const result = {
        employeeId: emp.id,
        employeeName: emp.full_name,
        eligible: false,
        eligibleDays: 0,
        eligibleStart: null,
        eligibleEnd: null,
        basicSalary: 0,
        allowances: 0,
        overtimeAmount: 0,
        advanceDeduction: 0,
        attendanceDeduction: 0,
        otherDeductions: 0,
        grossSalary: 0,
        totalDeductions: 0,
        netSalary: 0,
        scheduledRepayments: [],
        blocked: false,
        blockReason: null,
        warnings: [],
        errors: []
    };
    
    // Determine employee eligibility for earning period
    const hireDate = emp.hire_date;
    const employmentEndDate = emp.employment_end_date;
    
    // Parse hire date if exists
    let hireDateParts = null;
    if (hireDate) {
        hireDateParts = hireDate.split('/').map(Number);
    }
    
    // Parse employment end date if exists
    let employmentEndDateParts = null;
    if (employmentEndDate) {
        employmentEndDateParts = employmentEndDate.split('/').map(Number);
    }
    
    // Parse period start and end
    const periodStartParts = periodStart.split('/').map(Number);
    const periodEndParts = periodEnd.split('/').map(Number);
    
    // Check eligibility: hire_date <= period_end AND (employment_end_date IS NULL OR employment_end_date >= period_start)
    let isEligible = false;
    let eligibleStartParts = null;
    let eligibleEndParts = null;
    
    if (hireDateParts) {
        const hireCompare = compareJalaliDates(
            { year: hireDateParts[0], month: hireDateParts[1], day: hireDateParts[2] },
            { year: periodEndParts[0], month: periodEndParts[1], day: periodEndParts[2] }
        );
        
        if (hireCompare <= 0) {
            // hire_date <= period_end
            if (!employmentEndDateParts) {
                // No employment end date - employee is eligible
                isEligible = true;
                eligibleStartParts = hireDateParts;
                eligibleEndParts = periodEndParts;
            } else {
                // Check employment_end_date >= period_start
                const endCompare = compareJalaliDates(
                    { year: employmentEndDateParts[0], month: employmentEndDateParts[1], day: employmentEndDateParts[2] },
                    { year: periodStartParts[0], month: periodStartParts[1], day: periodStartParts[2] }
                );
                
                if (endCompare >= 0) {
                    isEligible = true;
                }
            }
        }
    }
    
    // Calculate eligible start and end if eligible
    if (isEligible) {
        // eligible_start = MAX(hire_date, period_start)
        if (hireDateParts) {
            const hireCompare = compareJalaliDates(
                { year: hireDateParts[0], month: hireDateParts[1], day: hireDateParts[2] },
                { year: periodStartParts[0], month: periodStartParts[1], day: periodStartParts[2] }
            );
            eligibleStartParts = hireCompare >= 0 ? hireDateParts : periodStartParts;
        } else {
            eligibleStartParts = periodStartParts;
        }
        
        // eligible_end = MIN(employment_end_date, period_end) if employment_end_date exists
        if (employmentEndDateParts) {
            const endCompare = compareJalaliDates(
                { year: employmentEndDateParts[0], month: employmentEndDateParts[1], day: employmentEndDateParts[2] },
                { year: periodEndParts[0], month: periodEndParts[1], day: periodEndParts[2] }
            );
            eligibleEndParts = endCompare <= 0 ? employmentEndDateParts : periodEndParts;
        } else {
            eligibleEndParts = periodEndParts;
        }
    }
    
    // Skip ineligible employees
    if (!isEligible) {
        result.blocked = true;
        result.blockReason = 'reason_not_eligible';
        return callback(null, result);
    }
    
    result.eligible = true;
    
    // Calculate eligible days (inclusive)
    const eligibleStartStr = `${eligibleStartParts[0]}/${eligibleStartParts[1].toString().padStart(2, '0')}/${eligibleStartParts[2].toString().padStart(2, '0')}`;
    const eligibleEndStr = `${eligibleEndParts[0]}/${eligibleEndParts[1].toString().padStart(2, '0')}/${eligibleEndParts[2].toString().padStart(2, '0')}`;
    
    result.eligibleStart = eligibleStartStr;
    result.eligibleEnd = eligibleEndStr;
    
    // Calculate inclusive day count
    let eligibleDays = 0;
    let currentDate = { year: eligibleStartParts[0], month: eligibleStartParts[1], day: eligibleStartParts[2] };
    const endDate = { year: eligibleEndParts[0], month: eligibleEndParts[1], day: eligibleEndParts[2] };
    
    while (compareJalaliDates(currentDate, endDate) <= 0) {
        eligibleDays++;
        // Move to next day
        if (currentDate.day < getDaysInJalaliMonth(currentDate.year, currentDate.month)) {
            currentDate.day++;
        } else {
            currentDate.day = 1;
            currentDate.month++;
            if (currentDate.month > 12) {
                currentDate.month = 1;
                currentDate.year++;
            }
        }
    }
    
    result.eligibleDays = eligibleDays;
    
    // Retrieve ALL salary history records overlapping the earning period
    db.all(`
        SELECT basic_salary, allowances, effective_from, effective_to
        FROM employee_salary_history 
        WHERE employee_id = ? 
        AND effective_from <= ?
        AND (effective_to IS NULL OR effective_to >= ?)
        ORDER BY effective_from ASC
    `, [emp.id, periodEnd, periodStart], (err, salaryRecords) => {
        if (err) {
            result.blocked = true;
            result.blockReason = 'reason_database_error_salary_history';
            return callback(err, result);
        }
        
        // If no salary records found, block employee
        if (!salaryRecords || salaryRecords.length === 0) {
            result.blocked = true;
            result.blockReason = 'reason_no_salary_history';
            result.errors.push('No salary history for eligible period');
            return callback(null, result);
        }
        
        // Calculate salary segments
        let segments = [];
        let totalBasicSalary = 0;
        let totalAllowances = 0;
        
        for (let i = 0; i < salaryRecords.length; i++) {
            const salary = salaryRecords[i];
            
            // Parse salary effective dates
            const salaryEffectiveFromParts = salary.effective_from.split('/').map(Number);
            let salaryEffectiveToParts = null;
            if (salary.effective_to) {
                salaryEffectiveToParts = salary.effective_to.split('/').map(Number);
            }
            
            // Calculate segment boundaries
            // segment_start = MAX(salary.effective_from, eligible_start)
            const fromCompare = compareJalaliDates(
                { year: salaryEffectiveFromParts[0], month: salaryEffectiveFromParts[1], day: salaryEffectiveFromParts[2] },
                { year: eligibleStartParts[0], month: eligibleStartParts[1], day: eligibleStartParts[2] }
            );
            const segmentStartParts = fromCompare >= 0 ? salaryEffectiveFromParts : eligibleStartParts;
            
            // segment_end = MIN(salary.effective_to, eligible_end) if effective_to exists, else eligible_end
            let segmentEndParts;
            if (salaryEffectiveToParts) {
                const toCompare = compareJalaliDates(
                    { year: salaryEffectiveToParts[0], month: salaryEffectiveToParts[1], day: salaryEffectiveToParts[2] },
                    { year: eligibleEndParts[0], month: eligibleEndParts[1], day: eligibleEndParts[2] }
                );
                segmentEndParts = toCompare <= 0 ? salaryEffectiveToParts : eligibleEndParts;
            } else {
                segmentEndParts = eligibleEndParts;
            }
            
            // Only include if segment_start <= segment_end
            const segmentValid = compareJalaliDates(segmentStartParts, segmentEndParts) <= 0;
            if (!segmentValid) {
                continue;
            }
            
            // Calculate segment days (inclusive)
            let segmentDays = 0;
            let segCurrentDate = { year: segmentStartParts[0], month: segmentStartParts[1], day: segmentStartParts[2] };
            const segEndDate = { year: segmentEndParts[0], month: segmentEndParts[1], day: segmentEndParts[2] };
            
            while (compareJalaliDates(segCurrentDate, segEndDate) <= 0) {
                segmentDays++;
                if (segCurrentDate.day < getDaysInJalaliMonth(segCurrentDate.year, segCurrentDate.month)) {
                    segCurrentDate.day++;
                } else {
                    segCurrentDate.day = 1;
                    segCurrentDate.month++;
                    if (segCurrentDate.month > 12) {
                        segCurrentDate.month = 1;
                        segCurrentDate.year++;
                    }
                }
            }
            
            // Prorate basic salary and allowances
            const basicEarned = Math.round((salary.basic_salary * segmentDays / periodEndDays) * 100) / 100;
            const allowanceEarned = Math.round((salary.allowances * segmentDays / periodEndDays) * 100) / 100;
            
            segments.push({
                start: segmentStartParts,
                end: segmentEndParts,
                days: segmentDays,
                basicSalary: salary.basic_salary,
                allowances: salary.allowances,
                basicEarned: basicEarned,
                allowanceEarned: allowanceEarned
            });
            
            totalBasicSalary += basicEarned;
            totalAllowances += allowanceEarned;
        }
        
        // Validate coverage: check for gaps between segments
        // Sort segments by start date
        segments.sort((a, b) => compareJalaliDates(a.start, b.start));
        
        // Check for overlapping salary segments
        for (let i = 0; i < segments.length - 1; i++) {
            const currentEnd = segments[i].end;
            const nextStart = segments[i + 1].start;
            
            // Next segment should start the day after current segment ends
            let nextDayAfterCurrent = { year: currentEnd[0], month: currentEnd[1], day: currentEnd[2] + 1 };
            if (nextDayAfterCurrent.day > getDaysInJalaliMonth(currentEnd[0], currentEnd[1])) {
                nextDayAfterCurrent.day = 1;
                nextDayAfterCurrent.month++;
                if (nextDayAfterCurrent.month > 12) {
                    nextDayAfterCurrent.month = 1;
                    nextDayAfterCurrent.year++;
                }
            }
            
            // If next segment starts before the day after current ends, there's an overlap
            const overlap = compareJalaliDates(nextStart, nextDayAfterCurrent);
            if (overlap < 0) {
                result.blocked = true;
                result.blockReason = 'reason_overlapping_salary_records';
                result.errors.push('Salary history overlap detected');
                return callback(null, result);
            }
        }
        
        // Check gap before first segment
        if (segments.length > 0) {
            const firstSegmentStart = segments[0].start;
            const gapBefore = compareJalaliDates(eligibleStartParts, firstSegmentStart);
            if (gapBefore < 0) {
                result.blocked = true;
                result.blockReason = 'reason_salary_gap_before_first';
                result.errors.push('Salary coverage gap at start of eligible period');
                return callback(null, result);
            }
        }
        
        // Check gaps between segments
        for (let i = 0; i < segments.length - 1; i++) {
            const currentEnd = segments[i].end;
            const nextStart = segments[i + 1].start;
            
            // Next segment should start the day after current segment ends
            let nextDayAfterCurrent = { year: currentEnd[0], month: currentEnd[1], day: currentEnd[2] + 1 };
            if (nextDayAfterCurrent.day > getDaysInJalaliMonth(currentEnd[0], currentEnd[1])) {
                nextDayAfterCurrent.day = 1;
                nextDayAfterCurrent.month++;
                if (nextDayAfterCurrent.month > 12) {
                    nextDayAfterCurrent.month = 1;
                    nextDayAfterCurrent.year++;
                }
            }
            
            // If next segment starts after the day after current ends, there's a gap
            const gap = compareJalaliDates(nextDayAfterCurrent, nextStart);
            if (gap < 0) {
                result.blocked = true;
                result.blockReason = 'reason_salary_gap_between_segments';
                result.errors.push('Salary coverage gap in history');
                return callback(null, result);
            }
        }
        
        // Check gap after last segment
        if (segments.length > 0) {
            const lastSegmentEnd = segments[segments.length - 1].end;
            const gapAfter = compareJalaliDates(lastSegmentEnd, eligibleEndParts);
            if (gapAfter < 0) {
                result.blocked = true;
                result.blockReason = 'reason_salary_gap_after_last';
                result.errors.push('Salary coverage gap at end of eligible period');
                return callback(null, result);
            }
        }
        
        // Round final totals
        const basicSalary = Math.round(totalBasicSalary * 100) / 100;
        const allowances = Math.round(totalAllowances * 100) / 100;
        
        result.basicSalary = basicSalary;
        result.allowances = allowances;
        
        // Calculate overtime if enabled
        let overtimeAmount = 0;
        if (include_overtime) {
            db.all('SELECT total_amount FROM overtime WHERE employee_id = ? AND status = "Approved" AND payroll_id IS NULL AND overtime_date >= ? AND overtime_date <= ?', [emp.id, periodStart, periodEnd], (err, overtimeRecords) => {
                if (!err && overtimeRecords) {
                    overtimeAmount = overtimeRecords.reduce((sum, ot) => sum + ot.total_amount, 0);
                }
                
                result.overtimeAmount = overtimeAmount;
                
                // Continue with other deductions, attendance, then advance repayment
                continueDeductionCalculation(basicSalary, allowances, overtimeAmount);
            });
        } else {
            continueDeductionCalculation(basicSalary, allowances, 0);
        }
        
        function continueAdvanceCalculation(basicSalary, allowances, overtimeAmount, otherDeductions, attendanceDeduction) {
            let advanceDeduction = 0;
            let scheduledRepayments = [];
            
            if (include_advances) {
                db.all('SELECT id, employee_id, date, repayment_amount, remaining_balance FROM salary_advances WHERE employee_id = ? AND remaining_balance > 0 AND date <= ? ORDER BY date ASC, id ASC', [emp.id, periodEnd], (err, advances) => {
                    if (!err && advances) {
                        const grossSalary = basicSalary + allowances + overtimeAmount;
                        let availableAdvanceBudget = Math.max(0, grossSalary - (attendanceDeduction || 0) - otherDeductions);
                        for (const adv of advances) {
                            if (availableAdvanceBudget <= 0) {
                                break;
                            }
                            if (adv.repayment_amount > 0) {
                                let actualRepayment = Math.min(adv.repayment_amount, adv.remaining_balance, availableAdvanceBudget);
                                // Float-safety: guarantee total deductions as summed in completeCalculation never exceed gross salary
                                while (actualRepayment > 0 && (advanceDeduction + actualRepayment + (attendanceDeduction || 0) + otherDeductions) > grossSalary) {
                                    actualRepayment = Math.round((actualRepayment - 0.01) * 100) / 100;
                                }
                                if (actualRepayment > 0) {
                                    advanceDeduction += actualRepayment;
                                    availableAdvanceBudget -= actualRepayment;
                                    scheduledRepayments.push({
                                        advanceId: adv.id,
                                        employeeId: adv.employee_id,
                                        actualRepayment: actualRepayment,
                                        newRemainingBalance: adv.remaining_balance - actualRepayment,
                                        shouldBePaid: actualRepayment === adv.remaining_balance
                                    });
                                }
                            } else if (adv.remaining_balance > 0) {
                                result.warnings.push(`Advance ${adv.id} has invalid repayment_amount (${adv.repayment_amount}), not automatically deducted`);
                            }
                        }
                    }
                    
                    result.advanceDeduction = advanceDeduction;
                    result.scheduledRepayments = scheduledRepayments;
                    
                    completeCalculation(basicSalary, allowances, overtimeAmount, advanceDeduction, otherDeductions, attendanceDeduction);
                });
            } else {
                completeCalculation(basicSalary, allowances, overtimeAmount, 0, otherDeductions, attendanceDeduction);
            }
        }
        
        function continueDeductionCalculation(basicSalary, allowances, overtimeAmount) {
            let otherDeductions = 0;
            
            if (include_deductions) {
                db.all('SELECT amount FROM salary_deductions WHERE employee_id = ? AND payroll_id IS NULL AND deduction_date >= ? AND deduction_date <= ?', [emp.id, periodStart, periodEnd], (err, deductionRecords) => {
                    if (!err && deductionRecords) {
                        otherDeductions = deductionRecords.reduce((sum, ded) => sum + ded.amount, 0);
                    }
                    
                    result.otherDeductions = otherDeductions;
                    continueAttendanceDeductionCalculation(basicSalary, allowances, overtimeAmount, otherDeductions);
                });
            } else {
                continueAttendanceDeductionCalculation(basicSalary, allowances, overtimeAmount, 0);
            }
        }

function continueAttendanceDeductionCalculation(basicSalary, allowances, overtimeAmount, otherDeductions) {
            // Query late attendance records with raw lateness (before any grace subtraction)
            // using actual check_in time vs expected check_in from the employee's work schedule
            // The universal 10-minute grace threshold is applied here, NOT the schedule-specific grace
            db.all(`
                SELECT 
                    a.attendance_date,
                    a.check_in,
                    a.late_minutes,
                    ws.expected_check_in,
                    COALESCE(
                        (SELECT esh.basic_salary FROM employee_salary_history esh 
                         WHERE esh.employee_id = a.employee_id 
                         AND esh.effective_from <= a.attendance_date 
                         AND (esh.effective_to IS NULL OR esh.effective_to >= a.attendance_date)
                         ORDER BY esh.effective_from DESC LIMIT 1),
                        0
                    ) as applicable_salary
                FROM attendance a
                LEFT JOIN hr_employees e ON a.employee_id = e.id
                LEFT JOIN work_schedules ws ON e.work_schedule_id = ws.id
                WHERE a.employee_id = ?
                AND a.attendance_date >= ? 
                AND a.attendance_date <= ?
                AND a.late_minutes > 0
                AND a.status != 'Holiday'
                AND a.status != 'Leave'
            `, [emp.id, periodStart, periodEnd], (err, attendanceRecords) => {
                let totalMonetaryDeduction = 0;
                if (!err && attendanceRecords) {
                    for (const record of attendanceRecords) {
                        if (record.applicable_salary > 0 && record.check_in && record.expected_check_in) {
                            // Calculate raw lateness from check_in vs expected_check_in
                            const actualParts = record.check_in.split(':');
                            const expectedParts = record.expected_check_in.split(':');
                            const actualMinutes = parseInt(actualParts[0], 10) * 60 + parseInt(actualParts[1], 10);
                            const expectedMinutes = parseInt(expectedParts[0], 10) * 60 + parseInt(actualParts[1], 10);
                            const rawLateness = actualMinutes - expectedMinutes;

                            // Universal 10-minute grace threshold (NOT subtracted from payable minutes)
                            if (rawLateness > 10) {
                                const minuteRate = record.applicable_salary / 30 / 8 / 60;
                                totalMonetaryDeduction += minuteRate * rawLateness; // NO floor per record
                            }
                        }
                    }
                }
                result.attendanceDeduction = Math.floor(totalMonetaryDeduction);
                continueAdvanceCalculation(basicSalary, allowances, overtimeAmount, otherDeductions, result.attendanceDeduction);
            });
        }

        function completeCalculation(basicSalary, allowances, overtimeAmount, advanceDeduction, otherDeductions, attendanceDeduction) {
    const grossSalary = basicSalary + allowances + overtimeAmount;
    const totalDeductions = advanceDeduction + (attendanceDeduction || 0) + otherDeductions;
    const netSalary = grossSalary - totalDeductions;
    
    result.grossSalary = grossSalary;
    result.totalDeductions = totalDeductions;
    result.netSalary = netSalary;
    
    // Check for negative net salary (warning only, blocking is done by caller)
    if (netSalary < 0) {
        result.blocked = true;
        result.blockReason = 'reason_negative_net_salary';
        result.warnings.push('Net salary is negative');
    } else if (netSalary === 0) {
        result.warnings.push('Net salary is zero');
    }
    
    callback(null, result);
        }

    }); // close salary db.all callback
}

// Get Employee Arrears
function getEmployeeArrears(db, employeeId, currentPayrollPeriod, callback) {
    const { calculateJalaliDaysBetween, validateJalaliDate } = require('../middleware/i18n');
    
    db.all(`
        SELECT
            id,
            payroll_period,
            net_salary,
            payment_status,
            due_date,
            settled_by_payroll_id
        FROM payroll
        WHERE employee_id = ?
          AND payment_status = 'Unpaid'
          AND payroll_period < ?
          AND settled_by_payroll_id IS NULL
        ORDER BY payroll_period ASC
    `, [employeeId, currentPayrollPeriod], (err, arrearsRecords) => {
        if (err) {
            return callback(err, null);
        }
        
        // Calculate days overdue for each record
        const recordsWithDaysOverdue = arrearsRecords.map(record => {
            let daysOverdue = null;
            
            if (record.due_date) {
                try {
                    const dueDateParts = record.due_date.split('/').map(Number);
                    const payDateParts = currentPayrollPeriod.split('/').map(Number);
                    
                    // Validate both dates
                    if (validateJalaliDate(dueDateParts[0], dueDateParts[1], dueDateParts[2]) &&
                        validateJalaliDate(payDateParts[0], payDateParts[1], payDateParts[2])) {
                        
                        const dueDate = { year: dueDateParts[0], month: dueDateParts[1], day: dueDateParts[2] };
                        const payDate = { year: payDateParts[0], month: payDateParts[1], day: payDateParts[2] };
                        
                        // Calculate days overdue (pay date - due date)
                        daysOverdue = calculateJalaliDaysBetween(dueDate, payDate);
                    }
                } catch (e) {
                    // If calculation fails, leave daysOverdue as null
                    console.error('Error calculating days overdue:', e);
                }
            }
            
            return {
                ...record,
                daysOverdue
            };
        });
        
        // Calculate total arrears
        const totalArrears = arrearsRecords.reduce((sum, record) => sum + record.net_salary, 0);
        
        callback(null, {
            records: recordsWithDaysOverdue,
            total: totalArrears
        });
    });
}

// Validate Selected Arrears
function validateSelectedArrears(db, employeeId, currentPayrollPeriod, selectedArrearsIds, callback) {
    const { compareJalaliDates, validateJalaliDate } = require('../middleware/i18n');
    
    if (!selectedArrearsIds || !Array.isArray(selectedArrearsIds) || selectedArrearsIds.length === 0) {
        return callback(null, {
            valid: true,
            selected: [],
            total: 0,
            errors: []
        });
    }
    
    // Validate current payroll period
    const currentParts = currentPayrollPeriod.split('/').map(Number);
    if (!validateJalaliDate(currentParts[0], currentParts[1], currentParts[2])) {
        return callback(null, {
            valid: false,
            selected: [],
            total: 0,
            errors: [`Invalid current payroll period: ${currentPayrollPeriod}`]
        });
    }
    
    // Validate each ID strictly - must be positive integer
    const errors = [];
    const validIds = [];
    
    selectedArrearsIds.forEach((id, index) => {
        // Check for null/undefined
        if (id === null || id === undefined) {
            errors.push(`Selected arrears ID at position ${index} is null or undefined`);
            return;
        }
        
        // Check for empty string
        if (id === '') {
            errors.push(`Selected arrears ID at position ${index} is empty`);
            return;
        }
        
        // Convert to number for validation
        const numId = Number(id);
        
        // Check if conversion resulted in NaN
        if (isNaN(numId)) {
            errors.push(`Selected arrears ID "${id}" at position ${index} is not a valid number`);
            return;
        }
        
        // Check for Infinity
        if (!isFinite(numId)) {
            errors.push(`Selected arrears ID "${id}" at position ${index} is not a finite number`);
            return;
        }
        
        // Check for non-integer (decimal)
        if (!Number.isInteger(numId)) {
            errors.push(`Selected arrears ID "${id}" at position ${index} is not an integer`);
            return;
        }
        
        // Check for zero or negative
        if (numId <= 0) {
            errors.push(`Selected arrears ID "${id}" at position ${index} must be a positive integer`);
            return;
        }
        
        // ID is valid - add to valid list
        validIds.push(numId);
    });
    
    // If there were validation errors, fail immediately
    if (errors.length > 0) {
        return callback(null, {
            valid: false,
            selected: [],
            total: 0,
            errors: errors
        });
    }
    
    // Deduplicate valid IDs
    const uniqueIds = [...new Set(validIds)];
    
    if (uniqueIds.length === 0) {
        return callback(null, {
            valid: false,
            selected: [],
            total: 0,
            errors: ['No valid selected arrears IDs provided']
        });
    }
    
    // Query the selected payroll records
    const placeholders = uniqueIds.map(() => '?').join(',');
    db.all(`
        SELECT
            id,
            employee_id,
            payroll_period,
            net_salary,
            payment_status,
            settled_by_payroll_id
        FROM payroll
        WHERE id IN (${placeholders})
    `, uniqueIds, (err, records) => {
        if (err) {
            return callback(err, null);
        }
        
        const selected = [];
        const businessErrors = [];
        const recordMap = new Map();
        
        // Build a map of retrieved records
        records.forEach(record => {
            recordMap.set(record.id, record);
        });
        
        // Validate each selected ID
        uniqueIds.forEach(id => {
            const record = recordMap.get(id);
            
            if (!record) {
                businessErrors.push(`Payroll ID ${id} does not exist`);
                return;
            }
            
            // Check employee ownership
            if (record.employee_id !== employeeId) {
                businessErrors.push(`Payroll ID ${id} belongs to a different employee`);
                return;
            }
            
            // Check if already paid
            if (record.payment_status !== 'Unpaid') {
                businessErrors.push(`Payroll ID ${id} is already paid (${record.payment_status})`);
                return;
            }
            
            // Check if already settled
            if (record.settled_by_payroll_id !== null) {
                businessErrors.push(`Payroll ID ${id} is already settled by payroll ${record.settled_by_payroll_id}`);
                return;
            }
            
            // Check if current period
            if (record.payroll_period === currentPayrollPeriod) {
                businessErrors.push(`Payroll ID ${id} is for the current period ${currentPayrollPeriod} and cannot be selected as arrears`);
                return;
            }
            
            // Validate selected arrears payroll period
            const recordParts = record.payroll_period.split('/').map(Number);
            if (!validateJalaliDate(recordParts[0], recordParts[1], recordParts[2])) {
                businessErrors.push(`Payroll ID ${id} has invalid payroll period: ${record.payroll_period}`);
                return;
            }
            
            // Check if future period (using Solar Hijri comparison)
            const currentDate = { year: currentParts[0], month: currentParts[1], day: currentParts[2] };
            const recordDate = { year: recordParts[0], month: recordParts[1], day: recordParts[2] };
            
            const comparison = compareJalaliDates(recordDate, currentDate);
            if (comparison > 0) {
                businessErrors.push(`Payroll ID ${id} is for a future period ${record.payroll_period}`);
                return;
            }
            
            // All validations passed - include in selected
            selected.push({
                id: record.id,
                payroll_period: record.payroll_period,
                net_salary: record.net_salary
            });
        });
        
        // Calculate total selected arrears
        const total = selected.reduce((sum, item) => sum + item.net_salary, 0);
        
        callback(null, {
            valid: businessErrors.length === 0,
            selected: selected,
            total: total,
            errors: businessErrors
        });
    });
}

// Generate Payroll
function hrGeneratePayroll(req, res) {
    const db = getDbConnection();
    const { getDaysInJalaliMonth, validateJalaliDate, compareJalaliDates } = require('../middleware/i18n');
    
    if (req.method === 'POST') {
        const { payroll_period, include_overtime: _ot, include_deductions: _ded, include_advances: _adv } = req.body;
        const include_overtime = toBool(_ot);
        const include_deductions = toBool(_ded);
        const include_advances = toBool(_adv);
        
        // Validate payroll_period format (YYYY/MM/DD)
        if (!payroll_period || !/^\d{4}\/\d{2}\/\d{2}$/.test(payroll_period)) {
            db.close();
            req.session.message = { type: 'error', text: res.locals.t('hr.payroll.invalid_date_format') };
            return res.redirect('/admin/hr/payroll/generate');
        }
        
        // Parse pay date
        const payDateParts = payroll_period.split('/').map(Number);
        const payYear = payDateParts[0];
        const payMonth = payDateParts[1];
        const payDay = payDateParts[2];
        
        // Validate as real Solar Hijri date
        if (!validateJalaliDate(payYear, payMonth, payDay)) {
            db.close();
            req.session.message = { type: 'error', text: res.locals.t('hr.payroll.invalid_jalali_date') };
            return res.redirect('/admin/hr/payroll/generate');
        }
        
        // Restrict to first day of month for monthly payroll
        if (payDay !== 1) {
            db.close();
            req.session.message = { type: 'error', text: res.locals.t('hr.payroll.must_be_first_day') };
            return res.redirect('/admin/hr/payroll/generate');
        }
        
        // PHASE 23 (OC-8): post-cutover legacy payroll creation is fenced (Phase 22B cutover rule)
        if (payroll_period >= '1405/07/01') {
            paymentController.auditLegacyFence(db, req, payroll_period, () => {
                db.close();
                req.session.message = { type: 'error', text: res.locals.t('hr.payroll.legacy_fenced') };
                res.redirect('/admin/hr/payroll/generate');
            });
            return;
        }
        
        // Derive earning period (immediately preceding month)
        let periodYear = payYear;
        let periodMonth = payMonth - 1;
        if (periodMonth < 1) {
            periodMonth = 12;
            periodYear--;
        }
        
        const periodStart = `${periodYear}/${periodMonth.toString().padStart(2, '0')}/01`;
        const periodEndDays = getDaysInJalaliMonth(periodYear, periodMonth);
        const periodEnd = `${periodYear}/${periodMonth.toString().padStart(2, '0')}/${periodEndDays}`;
        
        // Get all employees (eligibility determined by hire_date and employment_end_date)
        db.all('SELECT * FROM hr_employees', (err, employees) => {
            if (err) {
                db.close();
                return res.status(500).send(res.locals.t('hr.payroll.database_error'));
            }
            
            let generatedCount = 0;
            let skippedCount = 0;
            let employeeIndex = 0;
            
            // Process employees sequentially to avoid transaction overlap
            function processNextEmployee() {
                if (employeeIndex >= employees.length) {
                    // All employees processed
                    db.close();
                    req.session.message = {
                        type: 'success',
                        text: res.locals.t('hr.payroll.generated_success', { generated: generatedCount, skipped: skippedCount })
                    };
                    res.redirect('/admin/hr/payroll');
                    return;
                }
                
                const emp = employees[employeeIndex];
                employeeIndex++;
                
                // Check if payroll already exists for this employee and period
                db.get('SELECT id FROM payroll WHERE employee_id = ? AND payroll_period = ?', [emp.id, payroll_period], (err, existing) => {
                    if (err) {
                        console.error('Error checking existing payroll:', err);
                        processNextEmployee();
                        return;
                    }
                    
                    if (existing) {
                        skippedCount++;
                        processNextEmployee();
                        return;
                    }
                    
                    // Use the extracted calculation helper
                    calculateEmployeePayroll(db, emp, periodStart, periodEnd, periodEndDays, include_overtime, include_deductions, include_advances, (err, calcResult) => {
                        if (err) {
                            console.error('Error calculating payroll for employee:', err);
                            skippedCount++;
                            processNextEmployee();
                            return;
                        }
                        
                        // Skip if blocked (not eligible, no salary, gaps, overlaps)
                        if (calcResult.blocked) {
                            console.error(`Payroll calculation blocked for employee ${emp.id} (${emp.full_name}): ${calcResult.blockReason}`);
                            skippedCount++;
                            processNextEmployee();
                            return;
                        }
                        
                        const basicSalary = calcResult.basicSalary;
                        const allowances = calcResult.allowances;
                        const overtimeAmount = calcResult.overtimeAmount;
                        const advanceDeduction = calcResult.advanceDeduction;
                        const attendanceDeduction = calcResult.attendanceDeduction;
                        const otherDeductions = calcResult.otherDeductions;
                        const scheduledRepayments = calcResult.scheduledRepayments;
                        const grossSalary = calcResult.grossSalary;
                        const totalDeductions = calcResult.totalDeductions;
                        const netSalary = calcResult.netSalary;
                        
                        // Block payroll generation if net salary is negative
                        if (netSalary < 0) {
                            console.error(`Payroll generation blocked for employee ${emp.id} (${emp.full_name}): net salary is negative (${netSalary})`);
                            skippedCount++;
                            processNextEmployee();
                            return;
                        }
                        
                        // Set due_date equal to pay_date
                        const dueDate = payroll_period;
                        
                        // Begin transaction for atomic payroll + advance repayment operations
                        db.run('BEGIN TRANSACTION', (err) => {
                            if (err) {
                                console.error('Error beginning transaction:', err);
                                skippedCount++;
                                processNextEmployee();
                                return;
                            }
                            
                            // Create payroll record
                            db.run(`
                                INSERT INTO payroll (
                                    employee_id, payroll_period, basic_salary, allowances, overtime_amount,
                                    advance_deduction, attendance_deduction, other_deductions, gross_salary, total_deductions, net_salary,
                                    due_date, payment_status, created_by
                                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            `, [emp.id, payroll_period, basicSalary, allowances, overtimeAmount, advanceDeduction, attendanceDeduction, otherDeductions, grossSalary, totalDeductions, netSalary, dueDate, 'Unpaid', req.session.username], function(err) {
                                if (err) {
                                    console.error('Error creating payroll:', err);
                                    db.run('ROLLBACK', () => {
                                        skippedCount++;
                                        processNextEmployee();
                                    });
                                    return;
                                }
                                
                                generatedCount++;
                                const payrollId = this.lastID;
                                
                                // Create advance repayment records and update advance balances
                                if (scheduledRepayments.length > 0) {
                                    let repaymentIndex = 0;
                                    
                                    function processNextRepayment() {
                                        if (repaymentIndex >= scheduledRepayments.length) {
                                            // All repayments processed, now link overtime and deductions before commit
                                            linkOvertimeAndDeductions();
                                            return;
                                        }
                                        
                                        const repayment = scheduledRepayments[repaymentIndex];
                                        
                                        // Create repayment record
                                        db.run('INSERT INTO salary_advance_repayments (advance_id, employee_id, payroll_id, amount, payment_date, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)', 
                                            [repayment.advanceId, repayment.employeeId, payrollId, repayment.actualRepayment, payroll_period, 'Payroll deduction'], (err) => {
                                                if (err) {
                                                    console.error('Error creating advance repayment record:', err);
                                                    db.run('ROLLBACK', () => {
                                                        skippedCount++;
                                                        processNextEmployee();
                                                    });
                                                    return;
                                                }
                                                
                                                // Update advance remaining balance
                                                const newBalance = Math.round(repayment.newRemainingBalance * 100) / 100;
                                                const newStatus = repayment.shouldBePaid ? 'Paid' : 'Active';
                                                db.run('UPDATE salary_advances SET remaining_balance = ?, status = ? WHERE id = ?', 
                                                    [newBalance, newStatus, repayment.advanceId], (err) => {
                                                        if (err) {
                                                            console.error('Error updating advance balance:', err);
                                                            db.run('ROLLBACK', () => {
                                                                skippedCount++;
                                                                processNextEmployee();
                                                            });
                                                            return;
                                                        }
                                                        
                                                        repaymentIndex++;
                                                        processNextRepayment();
                                                    });
                                            });
                                    }
                                    
                                    function linkOvertimeAndDeductions() {
                                        // Link overtime records to this payroll (INSIDE transaction)
                                        if (include_overtime && overtimeAmount > 0) {
                                            db.run('UPDATE overtime SET payroll_id = ? WHERE employee_id = ? AND status = "Approved" AND payroll_id IS NULL AND overtime_date >= ? AND overtime_date <= ?', [payrollId, emp.id, periodStart, periodEnd], (err) => {
                                                if (err) {
                                                    console.error('Error linking overtime to payroll:', err);
                                                    db.run('ROLLBACK', () => {
                                                        skippedCount++;
                                                        processNextEmployee();
                                                    });
                                                    return;
                                                }
                                                linkDeductions();
                                            });
                                        } else {
                                            linkDeductions();
                                        }
                                    }
                                    
                                    function linkDeductions() {
                                        // Link deduction records to this payroll (INSIDE transaction)
                                        if (include_deductions && otherDeductions > 0) {
                                            db.run('UPDATE salary_deductions SET payroll_id = ? WHERE employee_id = ? AND payroll_id IS NULL AND deduction_date >= ? AND deduction_date <= ?', [payrollId, emp.id, periodStart, periodEnd], (err) => {
                                                if (err) {
                                                    console.error('Error linking deductions to payroll:', err);
                                                    db.run('ROLLBACK', () => {
                                                        skippedCount++;
                                                        processNextEmployee();
                                                    });
                                                    return;
                                                }
                                                commitTransaction();
                                            });
                                        } else {
                                            commitTransaction();
                                        }
                                    }
                                    
                                    function commitTransaction() {
                                        // Commit transaction
                                        db.run('COMMIT', (err) => {
                                            if (err) {
                                                console.error('Error committing transaction:', err);
                                                db.run('ROLLBACK', () => {
                                                    skippedCount++;
                                                    processNextEmployee();
                                                });
                                            } else {
                                                processNextEmployee();
                                            }
                                        });
                                    }
                                    
                                    processNextRepayment();
                                } else {
                                    // No repayments needed, link overtime and deductions before commit
                                    linkOvertimeAndDeductions();
                                    
                                    function linkOvertimeAndDeductions() {
                                        // Link overtime records to this payroll (INSIDE transaction)
                                        if (include_overtime && overtimeAmount > 0) {
                                            db.run('UPDATE overtime SET payroll_id = ? WHERE employee_id = ? AND status = "Approved" AND payroll_id IS NULL AND overtime_date >= ? AND overtime_date <= ?', [payrollId, emp.id, periodStart, periodEnd], (err) => {
                                                if (err) {
                                                    console.error('Error linking overtime to payroll:', err);
                                                    db.run('ROLLBACK', () => {
                                                        skippedCount++;
                                                        processNextEmployee();
                                                    });
                                                    return;
                                                }
                                                linkDeductions();
                                            });
                                        } else {
                                            linkDeductions();
                                        }
                                    }
                                    
                                    function linkDeductions() {
                                        // Link deduction records to this payroll (INSIDE transaction)
                                        if (include_deductions && otherDeductions > 0) {
                                            db.run('UPDATE salary_deductions SET payroll_id = ? WHERE employee_id = ? AND payroll_id IS NULL AND deduction_date >= ? AND deduction_date <= ?', [payrollId, emp.id, periodStart, periodEnd], (err) => {
                                                if (err) {
                                                    console.error('Error linking deductions to payroll:', err);
                                                    db.run('ROLLBACK', () => {
                                                        skippedCount++;
                                                        processNextEmployee();
                                                    });
                                                    return;
                                                }
                                                commitTransaction();
                                            });
                                        } else {
                                            commitTransaction();
                                        }
                                    }
                                    
                                    function commitTransaction() {
                                        // Commit transaction
                                        db.run('COMMIT', (err) => {
                                            if (err) {
                                                console.error('Error committing transaction:', err);
                                                db.run('ROLLBACK', () => {
                                                    skippedCount++;
                                                    processNextEmployee();
                                                });
                                            } else {
                                                processNextEmployee();
                                            }
                                        });
                                    }
                                }
                            });
                        });
                    });
                });
            }
            
            // Start processing first employee
            processNextEmployee();
        });
    } else {
        // GET request - show generation form with arrears information
        const db = getDbConnection();
        
        // Get current date for default period display
        const { getCurrentJalaliDate } = require('../middleware/i18n');
        const todayParts = getCurrentJalaliDate().split('/');
        const defaultPeriod = `${todayParts[0]}/${todayParts[1]}/01`;
        
        // Get all employees with their arrears
        db.all('SELECT * FROM hr_employees', (err, employees) => {
            if (err) {
                db.close();
                return res.status(500).send(res.locals.t('hr.payroll.database_error'));
            }
            
            // Calculate arrears for each employee using default period
            let employeesWithArrears = {};
            let arrearsProcessed = 0;
            
            employees.forEach(emp => {
                getEmployeeArrears(db, emp.id, defaultPeriod, (err, arrearsData) => {
                    if (!err && arrearsData) {
                        employeesWithArrears[emp.id] = arrearsData;
                    }
                    
                    arrearsProcessed++;
                    if (arrearsProcessed === employees.length) {
                        db.close();
                        
                        res.render('hr/payroll-generate', {
                            session: req.session,
                            employeesWithArrears
                        });
                    }
                });
            });
        });
    }
}

// Preview Payroll (Read-Only)
function hrPreviewPayroll(req, res) {
    const db = getDbConnection();
    const { getDaysInJalaliMonth, validateJalaliDate, compareJalaliDates } = require('../middleware/i18n');
    
    const { payroll_period, include_overtime: _ot, include_deductions: _ded, include_advances: _adv } = req.body;
    const include_overtime = toBool(_ot);
    const include_deductions = toBool(_ded);
    const include_advances = toBool(_adv);
    
    // Validate payroll_period format (YYYY/MM/DD)
    if (!payroll_period || !/^\d{4}\/\d{2}\/\d{2}$/.test(payroll_period)) {
        db.close();
        req.session.message = { type: 'error', text: res.locals.t('hr.payroll.invalid_date_format') };
        return res.redirect('/admin/hr/payroll/generate');
    }
    
    // Parse pay date
    const payDateParts = payroll_period.split('/').map(Number);
    const payYear = payDateParts[0];
    const payMonth = payDateParts[1];
    const payDay = payDateParts[2];
    
    // Validate as real Solar Hijri date
    if (!validateJalaliDate(payYear, payMonth, payDay)) {
        db.close();
        req.session.message = { type: 'error', text: res.locals.t('hr.payroll.invalid_jalali_date') };
        return res.redirect('/admin/hr/payroll/generate');
    }
    
    // Restrict to first day of month for monthly payroll
    if (payDay !== 1) {
        db.close();
        req.session.message = { type: 'error', text: res.locals.t('hr.payroll.must_be_first_day') };
        return res.redirect('/admin/hr/payroll/generate');
    }
    
    // PHASE 23 (OC-8): post-cutover legacy payroll preview is fenced (Phase 22B cutover rule)
    if (payroll_period >= '1405/07/01') {
        paymentController.auditLegacyFence(db, req, payroll_period, () => {
            db.close();
            req.session.message = { type: 'error', text: res.locals.t('hr.payroll.legacy_fenced') };
            res.redirect('/admin/hr/payroll/generate');
        });
        return;
    }
    
    // Derive earning period (immediately preceding month)
    let periodYear = payYear;
    let periodMonth = payMonth - 1;
    if (periodMonth < 1) {
        periodMonth = 12;
        periodYear--;
    }
    
    const periodStart = `${periodYear}/${periodMonth.toString().padStart(2, '0')}/01`;
    const periodEndDays = getDaysInJalaliMonth(periodYear, periodMonth);
    const periodEnd = `${periodYear}/${periodMonth.toString().padStart(2, '0')}/${periodEndDays}`;
    
    // Get all employees with department information
    db.all(`
        SELECT e.*, d.name as department_name 
        FROM hr_employees e 
        LEFT JOIN departments d ON e.department_id = d.id
    `, (err, employees) => {
        if (err) {
            db.close();
            return res.status(500).send(res.locals.t('hr.payroll.database_error'));
        }
        
        let previewResults = [];
        let processedCount = 0;
        let totals = {
            eligibleCount: 0,
            blockedCount: 0,
            alreadyGeneratedCount: 0,
            totalBasicSalary: 0,
            totalAllowances: 0,
            totalOvertime: 0,
            totalAdvanceDeduction: 0,
            totalAttendanceDeduction: 0,
            totalOtherDeductions: 0,
            totalGrossSalary: 0,
            totalDeductions: 0,
            totalNetSalary: 0,
            totalArrears: 0
        };
        
        // Process each employee
        employees.forEach(emp => {
            // Check if payroll already exists for this employee and period
            db.get('SELECT id FROM payroll WHERE employee_id = ? AND payroll_period = ?', [emp.id, payroll_period], (err, existing) => {
                if (err) {
                    console.error('Error checking existing payroll:', err);
                    processedCount++;
                    checkComplete();
                    return;
                }
                
                if (existing) {
                    // Employee already has payroll for this period
                    totals.alreadyGeneratedCount++;
                    previewResults.push({
                        employee: emp,
                        alreadyGenerated: true,
                        blocked: false,
                        blockReason: null,
                        warnings: ['Payroll already generated for this period'],
                        arrears: null
                    });
                    processedCount++;
                    checkComplete();
                    return;
                }
                
                // Calculate payroll using the extracted helper
                calculateEmployeePayroll(db, emp, periodStart, periodEnd, periodEndDays, include_overtime, include_deductions, include_advances, (err, calcResult) => {
                    if (err) {
                        console.error('Error calculating payroll for employee:', err);
                        processedCount++;
                        checkComplete();
                        return;
                    }
                    
                    // Get arrears for this employee
                    getEmployeeArrears(db, emp.id, payroll_period, (err, arrearsData) => {
                        if (err) {
                            console.error('Error getting arrears:', err);
                        }
                        
                        if (calcResult.blocked) {
                            totals.blockedCount++;
                        } else {
                            totals.eligibleCount++;
                            totals.totalBasicSalary += calcResult.basicSalary;
                            totals.totalAllowances += calcResult.allowances;
                            totals.totalOvertime += calcResult.overtimeAmount;
                        totals.totalAdvanceDeduction += calcResult.advanceDeduction;
                        totals.totalAttendanceDeduction = (totals.totalAttendanceDeduction || 0) + calcResult.attendanceDeduction;
                        totals.totalOtherDeductions += calcResult.otherDeductions;
                            totals.totalGrossSalary += calcResult.grossSalary;
                            totals.totalDeductions += calcResult.totalDeductions;
                            totals.totalNetSalary += calcResult.netSalary;
                        }
                        
                        if (arrearsData && arrearsData.total) {
                            totals.totalArrears += arrearsData.total;
                        }
                        
                        previewResults.push({
                            employee: emp,
                            alreadyGenerated: false,
                            blocked: calcResult.blocked,
                            blockReason: calcResult.blockReason,
                            warnings: calcResult.warnings,
                            errors: calcResult.errors,
                            calculation: calcResult,
                            arrears: arrearsData
                        });
                        
                        processedCount++;
                        checkComplete();
                    });
                });
            });
        });
        
        function checkComplete() {
            if (processedCount === employees.length) {
                db.close();
                
                // Sort results: non-blocked first, then blocked, then already generated
                previewResults.sort((a, b) => {
                    if (a.alreadyGenerated && !b.alreadyGenerated) return 1;
                    if (!a.alreadyGenerated && b.alreadyGenerated) return -1;
                    if (a.blocked && !b.blocked) return 1;
                    if (!a.blocked && b.blocked) return -1;
                    return 0;
                });
                
                res.render('hr/payroll-preview', {
                    session: req.session,
                    payroll_period,
                    periodStart,
                    periodEnd,
                    periodEndDays,
                    include_overtime,
                    include_deductions,
                    include_advances,
                    previewResults,
                    totals
                });
            }
        }
    });
}

// Create Payroll for Selected Employees
function hrCreateSelectedPayroll(req, res) {
    const db = getDbConnection();
    const { getDaysInJalaliMonth, validateJalaliDate, compareJalaliDates } = require('../middleware/i18n');
    
    const { selected_employees, payroll_period, include_overtime: _ot2, include_deductions: _ded2, include_advances: _adv2 } = req.body;
    const include_overtime = toBool(_ot2);
    const include_deductions = toBool(_ded2);
    const include_advances = toBool(_adv2);
    
    // Extract selected arrears for each employee
    const selectedArrearsMap = {};
    Object.keys(req.body).forEach(key => {
        if (key.startsWith('selected_arrears_')) {
            const employeeId = key.replace('selected_arrears_', '');
            try {
                selectedArrearsMap[employeeId] = JSON.parse(req.body[key]);
            } catch (e) {
                console.error('Error parsing selected arrears for employee:', employeeId, e);
            }
        }
    });
    
    // Validate selected_employees
    if (!selected_employees || !Array.isArray(selected_employees) || selected_employees.length === 0) {
        db.close();
        req.session.message = { type: 'error', text: res.locals.t('hr.payroll.no_employees_selected') };
        return res.redirect('/admin/hr/payroll/generate');
    }
    
    // Validate payroll_period format (YYYY/MM/DD)
    if (!payroll_period || !/^\d{4}\/\d{2}\/\d{2}$/.test(payroll_period)) {
        db.close();
        req.session.message = { type: 'error', text: res.locals.t('hr.payroll.invalid_date_format') };
        return res.redirect('/admin/hr/payroll/generate');
    }
    
    // Parse pay date
    const payDateParts = payroll_period.split('/').map(Number);
    const payYear = payDateParts[0];
    const payMonth = payDateParts[1];
    const payDay = payDateParts[2];
    
    // Validate as real Solar Hijri date
    if (!validateJalaliDate(payYear, payMonth, payDay)) {
        db.close();
        req.session.message = { type: 'error', text: res.locals.t('hr.payroll.invalid_jalali_date') };
        return res.redirect('/admin/hr/payroll/generate');
    }
    
    // Restrict to first day of month for monthly payroll
    if (payDay !== 1) {
        db.close();
        req.session.message = { type: 'error', text: res.locals.t('hr.payroll.must_be_first_day') };
        return res.redirect('/admin/hr/payroll/generate');
    }
    
    // PHASE 23 (OC-8): post-cutover legacy payroll creation is fenced (Phase 22B cutover rule)
    if (payroll_period >= '1405/07/01') {
        paymentController.auditLegacyFence(db, req, payroll_period, () => {
            db.close();
            req.session.message = { type: 'error', text: res.locals.t('hr.payroll.legacy_fenced') };
            res.redirect('/admin/hr/payroll/generate');
        });
        return;
    }
    
    // Derive earning period (immediately preceding month)
    let periodYear = payYear;
    let periodMonth = payMonth - 1;
    if (periodMonth < 1) {
        periodMonth = 12;
        periodYear--;
    }
    
    const periodStart = `${periodYear}/${periodMonth.toString().padStart(2, '0')}/01`;
    const periodEndDays = getDaysInJalaliMonth(periodYear, periodMonth);
    const periodEnd = `${periodYear}/${periodMonth.toString().padStart(2, '0')}/${periodEndDays}`;
    
    // Strict validation of selected employee IDs
    // Reject entire request if any ID is invalid or employee doesn't exist
    const validEmployeeIds = [];
    for (const id of selected_employees) {
        // Reject null, undefined, objects, arrays
        if (id === null || id === undefined || typeof id === 'object' || Array.isArray(id)) {
            db.close();
            req.session.message = { type: 'error', text: res.locals.t('hr.payroll.invalid_employee_ids') };
            return res.redirect('/admin/hr/payroll/generate');
        }
        
        // Convert to string for validation
        const idStr = String(id).trim();
        
        // Reject empty strings
        if (idStr === '') {
            db.close();
            req.session.message = { type: 'error', text: res.locals.t('hr.payroll.invalid_employee_ids') };
            return res.redirect('/admin/hr/payroll/generate');
        }
        
        // Reject if not a valid integer (no decimals, no scientific notation, no letters)
        if (!/^\d+$/.test(idStr)) {
            db.close();
            req.session.message = { type: 'error', text: res.locals.t('hr.payroll.invalid_employee_ids') };
            return res.redirect('/admin/hr/payroll/generate');
        }
        
        // Parse as integer
        const parsedId = parseInt(idStr, 10);
        
        // Reject zero or negative
        if (parsedId <= 0) {
            db.close();
            req.session.message = { type: 'error', text: res.locals.t('hr.payroll.invalid_employee_ids') };
            return res.redirect('/admin/hr/payroll/generate');
        }
        
        validEmployeeIds.push(parsedId);
    }
    
    // Deduplicate after strict validation
    const uniqueEmployeeIds = [...new Set(validEmployeeIds)];
    
    // Verify that EVERY requested employee exists before processing
    const placeholders = uniqueEmployeeIds.map(() => '?').join(',');
    db.all(`SELECT id FROM hr_employees WHERE id IN (${placeholders})`, uniqueEmployeeIds, (err, existingEmployees) => {
        if (err) {
            db.close();
            return res.status(500).send(res.locals.t('hr.payroll.database_error'));
        }
        
        // Reject if any requested employee doesn't exist
        if (existingEmployees.length !== uniqueEmployeeIds.length) {
            db.close();
            req.session.message = { type: 'error', text: res.locals.t('hr.payroll.employee_not_found') };
            return res.redirect('/admin/hr/payroll/generate');
        }
        
        // Now load full employee data for processing
        db.all(`SELECT * FROM hr_employees WHERE id IN (${placeholders})`, uniqueEmployeeIds, (err, employees) => {
            if (err) {
                db.close();
                return res.status(500).send(res.locals.t('hr.payroll.database_error'));
            }
            
            if (employees.length === 0) {
                db.close();
                req.session.message = { type: 'error', text: res.locals.t('hr.payroll.no_valid_employees') };
                return res.redirect('/admin/hr/payroll/generate');
            }
            
            let generatedCount = 0;
            let skippedCount = 0;
            let blockedCount = 0;
            let failedCount = 0;
            let employeeIndex = 0;
            const results = [];
            
            // Process employees sequentially to avoid transaction overlap
            function processNextEmployee() {
                if (employeeIndex >= employees.length) {
                    // All employees processed
                    db.close();
                    
                    // Render results page instead of redirecting
                    res.render('hr/payroll-results', {
                        session: req.session,
                        payroll_period,
                        results,
                        summary: {
                            totalSelected: employees.length,
                            createdCount: generatedCount,
                            skippedCount: skippedCount,
                            blockedCount: blockedCount,
                            failedCount: failedCount
                        }
                    });
                    return;
                }
            
            const emp = employees[employeeIndex];
            employeeIndex++;
            
            // Check if payroll already exists for this employee and period
            db.get('SELECT id FROM payroll WHERE employee_id = ? AND payroll_period = ?', [emp.id, payroll_period], (err, existing) => {
                if (err) {
                    console.error('Error checking existing payroll:', err);
                    failedCount++;
                    results.push({ employee: emp, status: 'failed', reasonKey: 'reason_database_error' });
                    processNextEmployee();
                    return;
                }
                
                if (existing) {
                    skippedCount++;
                    results.push({ employee: emp, status: 'skipped', reasonKey: 'reason_payroll_already_exists' });
                    processNextEmployee();
                    return;
                }
                
                // Use the extracted calculation helper
                calculateEmployeePayroll(db, emp, periodStart, periodEnd, periodEndDays, include_overtime, include_deductions, include_advances, (err, calcResult) => {
                    if (err) {
                        console.error('Error calculating payroll for employee:', err);
                        failedCount++;
                        results.push({ employee: emp, status: 'failed', reasonKey: 'reason_calculation_error' });
                        processNextEmployee();
                        return;
                    }
                    
                    // Skip if blocked (not eligible, no salary, gaps, overlaps)
                    if (calcResult.blocked) {
                        console.error(`Payroll calculation blocked for employee ${emp.id} (${emp.full_name}): ${calcResult.blockReason}`);
                        blockedCount++;
                        results.push({ employee: emp, status: 'blocked', reasonKey: calcResult.blockReason });
                        processNextEmployee();
                        return;
                    }
                    
                    const basicSalary = calcResult.basicSalary;
                    const allowances = calcResult.allowances;
                    const overtimeAmount = calcResult.overtimeAmount;
                    const advanceDeduction = calcResult.advanceDeduction;
                    const attendanceDeduction = calcResult.attendanceDeduction;
                    const otherDeductions = calcResult.otherDeductions;
                    const scheduledRepayments = calcResult.scheduledRepayments;
                    const grossSalary = calcResult.grossSalary;
                    const totalDeductions = calcResult.totalDeductions;
                    const netSalary = calcResult.netSalary;
                    
                    // Block payroll generation if net salary is negative
                    if (netSalary < 0) {
                        console.error(`Payroll generation blocked for employee ${emp.id} (${emp.full_name}): net salary is negative (${netSalary})`);
                        blockedCount++;
                        results.push({ employee: emp, status: 'blocked', reasonKey: 'reason_negative_net_salary' });
                        processNextEmployee();
                        return;
                    }
                    
                    // Define createPayrollWithArrears function BEFORE it's called
                    function createPayrollWithArrears(basicSalary, allowances, overtimeAmount, advanceDeduction, otherDeductions, scheduledRepayments, grossSalary, totalDeductions, netSalary, arrearsTotal, validatedArrears) {
                        // Phase 4.4: validatedArrears contains the validated arrears records from validateSelectedArrears()
                        // Each record has {id, payroll_period, net_salary}
                        // These will be settled (settled_by_payroll_id updated) after payroll INSERT succeeds
                        
                        // Set due_date equal to pay_date
                        const dueDate = payroll_period;
                    
                        // Begin transaction for atomic payroll + advance repayment + linking operations
                        db.run('BEGIN TRANSACTION', (err) => {
                        if (err) {
                            console.error('Error beginning transaction:', err);
                            failedCount++;
                            results.push({ employee: emp, status: 'failed', reasonKey: 'reason_transaction_error' });
                            processNextEmployee();
                            return;
                        }
                        
                        // Create payroll record
                        db.run(`
                            INSERT INTO payroll (
                                employee_id, payroll_period, basic_salary, allowances, overtime_amount,
                                advance_deduction, attendance_deduction, other_deductions, gross_salary, total_deductions, net_salary,
                                due_date, payment_status, created_by
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        `, [emp.id, payroll_period, basicSalary, allowances, overtimeAmount, advanceDeduction, attendanceDeduction, otherDeductions, grossSalary, totalDeductions, netSalary, dueDate, 'Unpaid', req.session.username], function(err) {
                            if (err) {
                                console.error('Error creating payroll:', err);
                                db.run('ROLLBACK', () => {
                                    failedCount++;
                                    results.push({ employee: emp, status: 'failed', reasonKey: 'reason_payroll_creation_failed' });
                                    processNextEmployee();
                                });
                                return;
                            }
                            
                            const payrollId = this.lastID;
                            
                            // Create advance repayment records and update advance balances
                            if (scheduledRepayments.length > 0) {
                                let repaymentIndex = 0;
                                
                                function processNextRepayment() {
                                    if (repaymentIndex >= scheduledRepayments.length) {
                                        // All repayments processed, now settle arrears (Phase 4.4) before linking
                                        settleArrears();
                                        return;
                                    }
                                    
                                    const repayment = scheduledRepayments[repaymentIndex];
                                    
                                    // Create repayment record
                                    db.run('INSERT INTO salary_advance_repayments (advance_id, employee_id, payroll_id, amount, payment_date, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)', 
                                        [repayment.advanceId, repayment.employeeId, payrollId, repayment.actualRepayment, payroll_period, 'Payroll deduction'], (err) => {
                                            if (err) {
                                                console.error('Error creating advance repayment record:', err);
                                                db.run('ROLLBACK', () => {
                                                    failedCount++;
                                                    results.push({ employee: emp, status: 'failed', reasonKey: 'reason_repayment_creation_failed' });
                                                    processNextEmployee();
                                                });
                                                return;
                                            }
                                            
                                            // Update advance remaining balance
                                            const newBalance = Math.round(repayment.newRemainingBalance * 100) / 100;
                                            const newStatus = repayment.shouldBePaid ? 'Paid' : 'Active';
                                            db.run('UPDATE salary_advances SET remaining_balance = ?, status = ? WHERE id = ?', 
                                                [newBalance, newStatus, repayment.advanceId], (err) => {
                                                    if (err) {
                                                        console.error('Error updating advance balance:', err);
                                                        db.run('ROLLBACK', () => {
                                                            failedCount++;
                                                            results.push({ employee: emp, status: 'failed', reasonKey: 'reason_advance_update_failed' });
                                                            processNextEmployee();
                                                        });
                                                        return;
                                                    }
                                                    
                                                    repaymentIndex++;
                                                    processNextRepayment();
                                                });
                                        });
                                }
                                
                                processNextRepayment();
                            } else {
                                // No repayments needed, proceed to arrears settlement (Phase 4.4)
                                settleArrears();
                            }
                            
                            // Phase 4.4: Settle selected arrears (settleArrears called from repayment completion)
                            function settleArrears() {
                                // If no validated arrears, skip directly to linking
                                if (!validatedArrears || validatedArrears.length === 0) {
                                    linkOvertimeAndDeductions();
                                    return;
                                }
                                
                                // Mark new payroll as including arrears
                                db.run('UPDATE payroll SET includes_arrears = 1 WHERE id = ?', [payrollId], (err) => {
                                    if (err) {
                                        console.error('Error marking payroll as including arrears:', err);
                                        db.run('ROLLBACK', () => {
                                            failedCount++;
                                            results.push({ employee: emp, status: 'failed', reasonKey: 'reason_arrears_settlement_failed' });
                                            processNextEmployee();
                                        });
                                        return;
                                    }
                                    
                                    // Settle each validated arrears record sequentially
                                    let arrearsIndex = 0;
                                    
                                    function settleNextArrears() {
                                        if (arrearsIndex >= validatedArrears.length) {
                                            // All arrears settled, proceed to linking
                                            linkOvertimeAndDeductions();
                                            return;
                                        }
                                        
                                        const arrearsRecord = validatedArrears[arrearsIndex];
                                        
                                        // Update old arrears payroll's settled_by_payroll_id
                                        // Use AND settled_by_payroll_id IS NULL for idempotency
                                        db.run('UPDATE payroll SET settled_by_payroll_id = ? WHERE id = ? AND settled_by_payroll_id IS NULL', [payrollId, arrearsRecord.id], function(err) {
                                            if (err) {
                                                console.error('Error settling arrears record:', arrearsRecord.id, err);
                                                db.run('ROLLBACK', () => {
                                                    failedCount++;
                                                    results.push({ employee: emp, status: 'failed', reasonKey: 'reason_arrears_settlement_failed' });
                                                    processNextEmployee();
                                                });
                                                return;
                                            }
                                            
                                            // Check if the update actually affected a row
                                            // If changes === 0, the arrears was already settled (race condition)
                                            if (this.changes === 0) {
                                                console.error('Arrears record already settled (race condition detected):', arrearsRecord.id);
                                                db.run('ROLLBACK', () => {
                                                    failedCount++;
                                                    results.push({ employee: emp, status: 'failed', reasonKey: 'reason_arrears_already_settled' });
                                                    processNextEmployee();
                                                });
                                                return;
                                            }
                                            
                                            arrearsIndex++;
                                            settleNextArrears();
                                        });
                                    }
                                    
                                    settleNextArrears();
                                });
                            }
                            
                            function linkOvertimeAndDeductions() {
                                // Link overtime records to this payroll (INSIDE transaction)
                                if (include_overtime && overtimeAmount > 0) {
                                    db.run('UPDATE overtime SET payroll_id = ? WHERE employee_id = ? AND status = "Approved" AND payroll_id IS NULL AND overtime_date >= ? AND overtime_date <= ?', [payrollId, emp.id, periodStart, periodEnd], (err) => {
                                        if (err) {
                                            console.error('Error linking overtime to payroll:', err);
                                            db.run('ROLLBACK', () => {
                                                failedCount++;
                                                results.push({ employee: emp, status: 'failed', reasonKey: 'reason_overtime_linking_failed' });
                                                processNextEmployee();
                                            });
                                            return;
                                        }
                                        linkDeductions();
                                    });
                                } else {
                                    linkDeductions();
                                }
                            }
                            
                            function linkDeductions() {
                                // Link deduction records to this payroll (INSIDE transaction)
                                if (include_deductions && otherDeductions > 0) {
                                    db.run('UPDATE salary_deductions SET payroll_id = ? WHERE employee_id = ? AND payroll_id IS NULL AND deduction_date >= ? AND deduction_date <= ?', [payrollId, emp.id, periodStart, periodEnd], (err) => {
                                        if (err) {
                                            console.error('Error linking deductions to payroll:', err);
                                            db.run('ROLLBACK', () => {
                                                failedCount++;
                                                results.push({ employee: emp, status: 'failed', reasonKey: 'reason_deduction_linking_failed' });
                                                processNextEmployee();
                                            });
                                            return;
                                        }
                                        commitTransaction();
                                    });
                                } else {
                                    commitTransaction();
                                }
                            }
                            
                            function commitTransaction() {
                                // Commit transaction
                                db.run('COMMIT', (err) => {
                                    if (err) {
                                        console.error('Error committing transaction:', err);
                                        db.run('ROLLBACK', () => {
                                            failedCount++;
                                            results.push({ employee: emp, status: 'failed', reasonKey: 'reason_commit_failed' });
                                            processNextEmployee();
                                        });
                                    } else {
                                        generatedCount++;
                                        results.push({ employee: emp, status: 'created', payrollId: payrollId });
                                        processNextEmployee();
                                    }
                                });
                            }
                        });
                    });
                } // End of createPayrollWithArrears function
                    
                    // Validate selected arrears using Phase 4.2 validation
                    const employeeArrearsIds = selectedArrearsMap[emp.id] || [];
                    if (employeeArrearsIds.length > 0) {
                        validateSelectedArrears(db, emp.id, payroll_period, employeeArrearsIds, (err, validation) => {
                            if (err) {
                                console.error('Error validating selected arrears:', err);
                                failedCount++;
                                results.push({ employee: emp, status: 'failed', reasonKey: 'reason_database_error' });
                                processNextEmployee();
                                return;
                            }
                            
                            if (!validation.valid) {
                                console.error(`Selected arrears validation failed for employee ${emp.id} (${emp.full_name}):`, validation.errors);
                                failedCount++;
                                results.push({ 
                                    employee: emp, 
                                    status: 'failed', 
                                    reasonKey: 'reason_arrears_validation_failed',
                                    arrearsErrors: validation.errors 
                                });
                                processNextEmployee();
                                return;
                            }
                            
                            // Arrears validated successfully - proceed with payroll creation (Phase 4.4: pass validated arrears for settlement)
                            createPayrollWithArrears(basicSalary, allowances, overtimeAmount, advanceDeduction, otherDeductions, scheduledRepayments, grossSalary, totalDeductions, netSalary, validation.total, validation.selected);
                        });
                    } else {
                        // No arrears selected - proceed with payroll creation (Phase 4.4: pass empty arrears array)
                        createPayrollWithArrears(basicSalary, allowances, overtimeAmount, advanceDeduction, otherDeductions, scheduledRepayments, grossSalary, totalDeductions, netSalary, 0, []);
                    }
                }); // End of calculateEmployeePayroll callback
            }); // End of db.get callback
        } // End of processNextEmployee function
        
        // Start processing first employee
        processNextEmployee();
        });
    });
}

// Payroll Detail
function hrPayrollDetail(req, res) {
    const db = getDbConnection();
    const payrollId = req.params.id;
    
    db.get(`
        SELECT p.*, e.full_name, e.employee_id, e.position, d.name as department_name 
        FROM payroll p 
        LEFT JOIN hr_employees e ON p.employee_id = e.id 
        LEFT JOIN departments d ON e.department_id = d.id
        WHERE p.id = ?
    `, [payrollId], (err, payroll) => {
        if (err) {
            db.close();
            return res.status(500).send('Database error');
        }
        
        if (!payroll) {
            db.close();
            return res.status(404).send('Payroll record not found');
        }
        
        db.close();
        
        res.render('hr/payroll-detail', {
            payroll,
            session: req.session
        });
    });
}

// Mark Payroll as Paid
function hrMarkPayrollPaid(req, res) {
    const db = getDbConnection();
    const payrollId = req.params.id;
    const { validateJalaliDate, compareJalaliDates } = require('../middleware/i18n');
    
    if (req.method === 'POST') {
        const { payment_date, payment_method, payment_reference, notes } = req.body;
        
        // Validate payment_date format (YYYY/MM/DD)
        if (!payment_date || !/^\d{4}\/\d{2}\/\d{2}$/.test(payment_date)) {
            db.close();
            req.session.message = { type: 'error', text: res.locals.t('hr.payroll.invalid_date_format') };
            return res.redirect(`/admin/hr/payroll/${payrollId}`);
        }
        
        // Parse payment date
        const paymentDateParts = payment_date.split('/').map(Number);
        const paymentYear = paymentDateParts[0];
        const paymentMonth = paymentDateParts[1];
        const paymentDay = paymentDateParts[2];
        
        // Validate as real Solar Hijri date
        if (!validateJalaliDate(paymentYear, paymentMonth, paymentDay)) {
            db.close();
            req.session.message = { type: 'error', text: res.locals.t('hr.payroll.invalid_jalali_date') };
            return res.redirect(`/admin/hr/payroll/${payrollId}`);
        }
        
        db.get('SELECT * FROM payroll WHERE id = ?', [payrollId], (err, payroll) => {
            if (err) {
                db.close();
                req.session.message = { type: 'error', text: res.locals.t('hr.payroll.database_error') };
                return res.redirect(`/admin/hr/payroll/${payrollId}`);
            }
            
            if (!payroll) {
                db.close();
                req.session.message = { type: 'error', text: res.locals.t('hr.payroll.payroll_not_found') };
                return res.redirect(`/admin/hr/payroll/${payrollId}`);
            }
            
            // Phase 25C — post-cutover legacy payroll fence (refuse before ANY update)
            if (String(payroll.payroll_period) >= '1405/07/01') {
                paymentController.auditLegacyFence(db, req, payroll.payroll_period, function() {
                    db.close();
                    req.session.message = { type: 'error', text: 'Post-cutover payroll periods cannot be marked paid through the legacy payroll flow.' };
                    res.redirect(`/admin/hr/payroll/${payrollId}`);
                });
                return;
            }
            
            // Check if payroll is already paid
            if (payroll.payment_status === 'Paid' || payroll.payment_status === 'Paid Early' || payroll.payment_status === 'Paid Late') {
                db.close();
                req.session.message = { type: 'error', text: res.locals.t('hr.payroll.already_paid') };
                return res.redirect(`/admin/hr/payroll/${payrollId}`);
            }
            
            // Determine payment status based on dates using Solar Hijri comparison
            let paymentStatus = 'Paid';
            if (payroll.due_date) {
                // Parse due date if it exists
                const dueDateParts = payroll.due_date.split('/').map(Number);
                const dueYear = dueDateParts[0];
                const dueMonth = dueDateParts[1];
                const dueDay = dueDateParts[2];
                
                // Validate due date before comparison
                if (validateJalaliDate(dueYear, dueMonth, dueDay)) {
                    const paymentDateObj = { year: paymentYear, month: paymentMonth, day: paymentDay };
                    const dueDateObj = { year: dueYear, month: dueMonth, day: dueDay };
                    
                    const comparison = compareJalaliDates(paymentDateObj, dueDateObj);
                    if (comparison < 0) {
                        paymentStatus = 'Paid Early';
                    } else if (comparison > 0) {
                        paymentStatus = 'Paid Late';
                    }
                }
                // If due date is invalid, default to 'Paid'
            }
            // If due_date is NULL, default to 'Paid'
            
            db.run(`
                UPDATE payroll SET
                    payment_date = ?,
                    payment_method = ?,
                    payment_reference = ?,
                    payment_status = ?,
                    paid_by = ?,
                    notes = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND payment_status NOT IN ('Paid', 'Paid Early', 'Paid Late')
            `, [payment_date, payment_method, payment_reference, paymentStatus, req.session.username, notes, payrollId], function(err) {
                if (err) {
                    console.error('Error marking payroll as paid:', err);
                    req.session.message = { type: 'error', text: res.locals.t('hr.payroll.mark_paid_error') };
                    db.close();
                    res.redirect(`/admin/hr/payroll/${payrollId}`);
                    return;
                }
                
                if (this.changes === 0) {
                    db.close();
                    req.session.message = { type: 'error', text: res.locals.t('hr.payroll.already_paid') };
                    return res.redirect(`/admin/hr/payroll/${payrollId}`);
                }
                
                req.session.message = { type: 'success', text: res.locals.t('hr.payroll.mark_paid_success') };
                
                // Create notification for payroll paid
                const notificationMessage = `Payroll for period ${payroll.payroll_period} marked as paid for ${payroll.full_name}`;
                db.run(`
                    INSERT INTO admin_notifications (type, message, related_record_id, related_record_type, created_by, recipient, is_read, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
                `, ['hr_payroll_paid', notificationMessage, payrollId, 'payroll', req.session.username, req.session.username], function(notifErr) {
                    if (notifErr) {
                        console.error('[ERROR] Error creating HR payroll paid notification:', notifErr);
                    } else {
                        notificationSSE.broadcast({
                            id: this.lastID,
                            type: 'hr_payroll_paid',
                            message: notificationMessage,
                            related_record_id: payrollId,
                            related_record_type: 'payroll',
                            created_by: req.session.username,
                            recipient: req.session.username,
                            is_read: 0,
                            created_at: new Date().toISOString()
                        });
                    }
                    
                    db.close();
                    res.redirect(`/admin/hr/payroll/${payrollId}`);
                });
            });
        });
    }
}

// Salary Advances
function hrAdvances(req, res) {
    const db = getDbConnection();
    const { employee_id } = req.query;
    
    let query = `
        SELECT sa.*, e.full_name, e.employee_id, e.position, e.photo_path, sa.employee_id AS advance_employee_fk
        FROM salary_advances sa 
        LEFT JOIN hr_employees e ON sa.employee_id = e.id 
    `;
    const params = [];
    
    if (employee_id) {
        query += ` WHERE sa.employee_id = ?`;
        params.push(employee_id);
    }
    
    query += ' ORDER BY sa.created_at DESC';
    
    db.all(query, params, (err, advances) => {
        if (err) {
            db.close();
            return res.status(500).send('Database error');
        }
        
        const currentSalaryDate = getCurrentJalaliDate();
        db.all(`
            SELECT employee_id, basic_salary, allowances
            FROM employee_salary_history
            WHERE effective_from <= ?
              AND (effective_to IS NULL OR effective_to >= ?)
            ORDER BY effective_from DESC
        `, [currentSalaryDate, currentSalaryDate], (salErr, salaryRows) => {
            const currentSalaries = {};
            if (!salErr && salaryRows) {
                salaryRows.forEach(row => {
                    if (!(row.employee_id in currentSalaries)) {
                        currentSalaries[row.employee_id] = row;
                    }
                });
            }
            
            let contextEmployee = null;
            if (employee_id) {
                db.get('SELECT * FROM hr_employees WHERE id = ?', [employee_id], (err, emp) => {
                    if (err) {
                        db.close();
                        return res.status(500).send('Database error');
                    }
                    
                    if (!emp) {
                        db.close();
                        return res.status(404).send('Employee not found');
                    }
                    
                    contextEmployee = emp;
                    
                    db.all('SELECT id, full_name FROM hr_employees WHERE employment_status = "Active" ORDER BY full_name ASC', (err, employees) => {
                        if (err) {
                            db.close();
                            return res.status(500).send('Database error');
                        }
                        
                        db.close();
                        res.render('hr/advances', {
                            advances,
                            employees,
                            contextEmployee,
                            currentSalaries,
                            filters: { employee_id },
                            session: req.session
                        });
                    });
                });
            } else {
                db.all('SELECT id, full_name FROM hr_employees WHERE employment_status = "Active" ORDER BY full_name ASC', (err, employees) => {
                    db.close();
                    if (err) {
                        return res.status(500).send('Database error');
                    }
                    
                    res.render('hr/advances', {
                        advances,
                        employees,
                        contextEmployee,
                        currentSalaries,
                        filters: { employee_id },
                        session: req.session
                    });
                });
            }
        });
    });
}

// Add Advance
function hrAddAdvance(req, res) {
    const db = getDbConnection();
    
    if (req.method === 'POST') {
        const { employee_id, amount, date, reason, repayment_amount, context_employee_id } = req.body;
        
        const parsedAmount = parseFloat(amount);
        const parsedRepaymentAmount = parseFloat(repayment_amount || 0);
        
        if (isNaN(parsedAmount) || parsedAmount < 0) {
            db.close();
            req.session.message = { type: 'error', text: 'Invalid advance amount. Must be a non-negative number.' };
            const redirectUrl = context_employee_id ? `/admin/hr/advances?employee_id=${context_employee_id}` : '/admin/hr/advances';
            return res.redirect(redirectUrl);
        }
        
        if (isNaN(parsedRepaymentAmount) || parsedRepaymentAmount < 0) {
            db.close();
            req.session.message = { type: 'error', text: 'Invalid repayment amount. Must be a non-negative number.' };
            const redirectUrl = context_employee_id ? `/admin/hr/advances?employee_id=${context_employee_id}` : '/admin/hr/advances';
            return res.redirect(redirectUrl);
        }
        
        validateEmployeeExists(db, employee_id, (empErr) => {
            if (empErr) {
                db.close();
                req.session.message = { type: 'error', text: empErr.message };
                const redirectUrl = context_employee_id ? `/admin/hr/advances?employee_id=${context_employee_id}` : '/admin/hr/advances';
                return res.redirect(redirectUrl);
            }
        
        db.run(`
            INSERT INTO salary_advances (employee_id, amount, date, reason, repayment_amount, remaining_balance, status, approved_by)
            VALUES (?, ?, ?, ?, ?, ?, 'Active', ?)
        `, [employee_id, parsedAmount, date, reason, parsedRepaymentAmount, parsedAmount, req.session.username], (err) => {
            if (err) {
                console.error('Error adding advance:', err);
                req.session.message = { type: 'error', text: 'Error adding advance' };
            } else {
                req.session.message = { type: 'success', text: 'Advance added successfully!' };
            }
            
            db.close();
            const redirectUrl = context_employee_id ? `/admin/hr/advances?employee_id=${context_employee_id}` : '/admin/hr/advances';
            res.redirect(redirectUrl);
        });
        }); // close validateEmployeeExists
    }
}

// Advance Repayment
function hrAdvanceRepayment(req, res) {
    const db = getDbConnection();
    const advanceId = req.params.id;
    
    if (req.method === 'POST') {
        const { amount, payment_date, notes, payroll_id } = req.body;
        
        const repaymentAmount = parseFloat(amount);
        
        if (isNaN(repaymentAmount) || repaymentAmount <= 0) {
            db.close();
            req.session.message = { type: 'error', text: 'Invalid repayment amount. Must be a positive number.' };
            return res.redirect('/admin/hr/advances');
        }
        
        db.get('SELECT * FROM salary_advances WHERE id = ?', [advanceId], (err, advance) => {
            if (err) {
                db.close();
                return res.status(500).send('Database error');
            }
            
            if (!advance) {
                db.close();
                return res.status(404).send('Advance not found');
            }
            
            if (advance.status !== 'Active' && advance.status !== 'Partially Repaid') {
                db.close();
                req.session.message = { type: 'error', text: 'Cannot record repayment against a ' + advance.status.toLowerCase() + ' advance.' };
                return res.redirect('/admin/hr/advances');
            }
            
            if (advance.remaining_balance <= 0) {
                db.close();
                req.session.message = { type: 'error', text: 'This advance has no remaining balance.' };
                return res.redirect('/admin/hr/advances');
            }
            
            db.run('BEGIN TRANSACTION', (err) => {
                if (err) {
                    console.error('Error beginning transaction:', err);
                    db.close();
                    req.session.message = { type: 'error', text: 'Database error' };
                    return res.redirect('/admin/hr/advances');
                }
                
                db.get('SELECT remaining_balance FROM salary_advances WHERE id = ?', [advanceId], (err, freshAdvance) => {
                    if (err || !freshAdvance) {
                        db.run('ROLLBACK', () => {
                            db.close();
                            req.session.message = { type: 'error', text: 'Advance not found' };
                            res.redirect('/admin/hr/advances');
                        });
                        return;
                    }
                    
                    const cappedRepayment = Math.min(repaymentAmount, freshAdvance.remaining_balance);
                    
                    if (cappedRepayment <= 0) {
                        db.run('ROLLBACK', () => {
                            db.close();
                            req.session.message = { type: 'error', text: 'No remaining balance to repay.' };
                            res.redirect('/admin/hr/advances');
                        });
                        return;
                    }
                    
                    db.run(`
                        INSERT INTO salary_advance_repayments (advance_id, employee_id, payroll_id, amount, payment_date, notes)
                        VALUES (?, ?, ?, ?, ?, ?)
                    `, [advanceId, advance.employee_id, payroll_id || null, cappedRepayment, payment_date, notes], (err) => {
                        if (err) {
                            console.error('Error recording repayment:', err);
                            db.run('ROLLBACK', () => {
                                db.close();
                                req.session.message = { type: 'error', text: 'Error recording repayment' };
                                res.redirect('/admin/hr/advances');
                            });
                            return;
                        }
                        
                        db.run(`
                            UPDATE salary_advances SET
                                remaining_balance = remaining_balance - ?,
                                status = CASE
                                    WHEN remaining_balance - ? <= 0 THEN 'Fully Repaid'
                                    WHEN remaining_balance - ? < amount THEN 'Partially Repaid'
                                    ELSE 'Active'
                                END
                            WHERE id = ? AND remaining_balance >= ?
                        `, [cappedRepayment, cappedRepayment, cappedRepayment, advanceId, cappedRepayment], function(err) {
                            if (err) {
                                console.error('Error updating advance:', err);
                                db.run('ROLLBACK', () => {
                                    db.close();
                                    req.session.message = { type: 'error', text: 'Error updating advance' };
                                    res.redirect('/admin/hr/advances');
                                });
                                return;
                            }
                            
                            if (this.changes === 0) {
                                db.run('ROLLBACK', () => {
                                    db.close();
                                    req.session.message = { type: 'error', text: 'Insufficient balance. Please try again.' };
                                    res.redirect('/admin/hr/advances');
                                });
                                return;
                            }
                            
                            // PHASE 23 (OC-8B): ADV_REPAY_MANUAL audit — atomic with the repayment (Phase 22B U2)
                            db.run(`
                                INSERT INTO payment_audit
                                    (payment_id, action, entity, entity_id, field_name, old_value, new_value, reason, actor_id, created_at)
                                VALUES (NULL, 'ADV_REPAY_MANUAL', 'advance', ?, 'remaining_balance', ?, ?, ?, ?, CURRENT_TIMESTAMP)
                            `, [Number(advanceId), String(freshAdvance.remaining_balance),
                                String(freshAdvance.remaining_balance - cappedRepayment), notes || null,
                                Number(req.session.user_id) || 0], (auditErr) => {
                                if (auditErr) {
                                    console.error('Error writing ADV_REPAY_MANUAL audit:', auditErr);
                                    db.run('ROLLBACK', () => {
                                        db.close();
                                        req.session.message = { type: 'error', text: 'Error recording repayment' };
                                        res.redirect('/admin/hr/advances');
                                    });
                                    return;
                                }
                                
                            db.run('COMMIT', (err) => {
                                if (err) {
                                    console.error('Error committing transaction:', err);
                                    db.run('ROLLBACK', () => {
                                        db.close();
                                        req.session.message = { type: 'error', text: 'Database error' };
                                        res.redirect('/admin/hr/advances');
                                    });
                                    return;
                                }
                                
                                req.session.message = { type: 'success', text: 'Repayment recorded successfully!' };
                                db.close();
                                res.redirect('/admin/hr/advances');
                            });
                            });
                        });
                    });
                });
            });
        });
    }
}

// Salary Deductions
function hrDeductions(req, res) {
    const db = getDbConnection();
    const { employee_id } = req.query;
    
    let query = `
        SELECT sd.*, e.full_name, e.employee_id, e.position, e.photo_path
        FROM salary_deductions sd 
        LEFT JOIN hr_employees e ON sd.employee_id = e.id 
    `;
    const params = [];
    
    if (employee_id) {
        query += ` WHERE sd.employee_id = ?`;
        params.push(employee_id);
    }
    
    query += ' ORDER BY sd.deduction_date DESC';
    
    db.all(query, params, (err, deductions) => {
        if (err) {
            db.close();
            return res.status(500).send('Database error');
        }
        
        let contextEmployee = null;
        if (employee_id) {
            db.get('SELECT * FROM hr_employees WHERE id = ?', [employee_id], (err, emp) => {
                if (err) {
                    db.close();
                    return res.status(500).send('Database error');
                }
                
                if (!emp) {
                    db.close();
                    return res.status(404).send('Employee not found');
                }
                
                contextEmployee = emp;
                
                db.all('SELECT id, full_name FROM hr_employees WHERE employment_status = "Active" ORDER BY full_name ASC', (err, employees) => {
                    if (err) {
                        db.close();
                        return res.status(500).send('Database error');
                    }
                    
                    db.close();
                    res.render('hr/deductions', {
                        deductions,
                        employees,
                        contextEmployee,
                        filters: { employee_id },
                        session: req.session
                    });
                });
            });
        } else {
            db.all('SELECT id, full_name FROM hr_employees WHERE employment_status = "Active" ORDER BY full_name ASC', (err, employees) => {
                db.close();
                if (err) {
                    return res.status(500).send('Database error');
                }
                
                res.render('hr/deductions', {
                    deductions,
                    employees,
                    contextEmployee,
                    filters: { employee_id },
                    session: req.session
                });
            });
        }
    });
}

// Add Deduction
function hrAddDeduction(req, res) {
    const db = getDbConnection();
    
    if (req.method === 'POST') {
        const { employee_id, deduction_type, amount, deduction_date, reason, payroll_id, context_employee_id } = req.body;
        
        const parsedAmount = parseFloat(amount);
        
        if (isNaN(parsedAmount) || parsedAmount < 0) {
            db.close();
            req.session.message = { type: 'error', text: 'Invalid deduction amount. Must be a non-negative number.' };
            const redirectUrl = context_employee_id ? `/admin/hr/deductions?employee_id=${context_employee_id}` : '/admin/hr/deductions';
            return res.redirect(redirectUrl);
        }
        
        validateEmployeeExists(db, employee_id, (empErr) => {
            if (empErr) {
                db.close();
                req.session.message = { type: 'error', text: empErr.message };
                const redirectUrl = context_employee_id ? `/admin/hr/deductions?employee_id=${context_employee_id}` : '/admin/hr/deductions';
                return res.redirect(redirectUrl);
            }
        
        const insertDeduction = () => {
            db.run(`
                INSERT INTO salary_deductions (employee_id, payroll_id, deduction_type, amount, deduction_date, reason, approved_by)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [employee_id, payroll_id || null, deduction_type, parsedAmount, deduction_date, reason, req.session.username], (err) => {
                if (err) {
                    console.error('Error adding deduction:', err);
                    req.session.message = { type: 'error', text: 'Error adding deduction' };
                } else {
                    req.session.message = { type: 'success', text: 'Deduction added successfully!' };
                }
                
                db.close();
                const redirectUrl = context_employee_id ? `/admin/hr/deductions?employee_id=${context_employee_id}` : '/admin/hr/deductions';
                res.redirect(redirectUrl);
            });
        };
        
        if (payroll_id) {
            db.get("SELECT id FROM payroll WHERE id = ? AND employee_id = ? AND payment_status NOT IN ('Paid', 'Paid Early', 'Paid Late')", [payroll_id, employee_id], (err, record) => {
                if (err || !record) {
                    db.close();
                    req.session.message = { type: 'error', text: 'Referenced payroll record not found or does not belong to this employee.' };
                    const redirectUrl = context_employee_id ? `/admin/hr/deductions?employee_id=${context_employee_id}` : '/admin/hr/deductions';
                    return res.redirect(redirectUrl);
                }
                insertDeduction();
            });
        } else {
            insertDeduction();
        }
        }); // close validateEmployeeExists
    } else {
        db.close();
        res.redirect('/admin/hr/deductions');
    }
}

// Leave Requests
function hrLeaveRequests(req, res) {
    const db = getDbConnection();
    const { employee_id } = req.query;
    
    let query = `
        SELECT lr.*, e.full_name, e.employee_id, e.photo_path, lt.name as leave_type_name 
        FROM leave_requests lr 
        LEFT JOIN hr_employees e ON lr.employee_id = e.id 
        LEFT JOIN leave_types lt ON lr.leave_type_id = lt.id 
    `;
    const params = [];
    
    if (employee_id) {
        query += ` WHERE lr.employee_id = ?`;
        params.push(employee_id);
    }
    
    query += ' ORDER BY lr.created_at DESC';
    
    db.all(query, params, (err, leaveRequests) => {
        if (err) {
            db.close();
            return res.status(500).send('Database error');
        }
        
        let contextEmployee = null;
        if (employee_id) {
            db.get('SELECT * FROM hr_employees WHERE id = ?', [employee_id], (err, emp) => {
                if (err) {
                    db.close();
                    return res.status(500).send('Database error');
                }
                
                if (!emp) {
                    db.close();
                    return res.status(404).send('Employee not found');
                }
                
                contextEmployee = emp;
                
                db.all('SELECT id, full_name FROM hr_employees WHERE employment_status = "Active" ORDER BY full_name ASC', (err, employees) => {
                    if (err) {
                        db.close();
                        return res.status(500).send('Database error');
                    }
                    
                    db.all('SELECT * FROM leave_types WHERE active = 1 ORDER BY name ASC', (err, leaveTypes) => {
                        if (err) {
                            db.close();
                            return res.status(500).send('Database error');
                        }
                        
                        db.close();
                        res.render('hr/leave-requests', {
                            leaveRequests,
                            employees,
                            leaveTypes,
                            contextEmployee,
                            filters: { employee_id },
                            session: req.session
                        });
                    });
                });
            });
        } else {
            db.all('SELECT id, full_name FROM hr_employees WHERE employment_status = "Active" ORDER BY full_name ASC', (err, employees) => {
                if (err) {
                    db.close();
                    return res.status(500).send('Database error');
                }
                
                db.all('SELECT * FROM leave_types WHERE active = 1 ORDER BY name ASC', (err, leaveTypes) => {
                    db.close();
                    if (err) {
                        return res.status(500).send('Database error');
                    }
                    
                    res.render('hr/leave-requests', {
                        leaveRequests,
                        employees,
                        leaveTypes,
                        contextEmployee,
                        filters: { employee_id },
                        session: req.session
                    });
                });
            });
        }
    });
}

// Add Leave Request
function hrAddLeaveRequest(req, res) {
    const db = getDbConnection();
    
    if (req.method === 'POST') {
        const { employee_id, leave_type_id, start_date, end_date, reason, context_employee_id } = req.body;
        
        const redirectUrl = context_employee_id ? `/admin/hr/leave?employee_id=${context_employee_id}` : '/admin/hr/leave';
        
        validateEmployeeExists(db, employee_id, (empErr) => {
            if (empErr) {
                db.close();
                req.session.message = { type: 'error', text: empErr.message };
                return res.redirect(redirectUrl);
            }
        
        // Validate dates are real/valid
        const startDate = new Date(start_date);
        const endDate = new Date(end_date);
        
        if (!start_date || isNaN(startDate.getTime())) {
            db.close();
            req.session.message = { type: 'error', text: 'Invalid leave start date.' };
            return res.redirect(redirectUrl);
        }
        
        if (!end_date || isNaN(endDate.getTime())) {
            db.close();
            req.session.message = { type: 'error', text: 'Invalid leave end date.' };
            return res.redirect(redirectUrl);
        }
        
        // Reject start_date > end_date
        if (startDate > endDate) {
            db.close();
            req.session.message = { type: 'error', text: 'Leave end date must be on or after start date.' };
            return res.redirect(redirectUrl);
        }
        
        // Calculate days only after date validation
        const days = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
        
        // Reject days < 1
        if (days < 1) {
            db.close();
            req.session.message = { type: 'error', text: 'Leave request must be for at least 1 day.' };
            return res.redirect(redirectUrl);
        }
        
        // Validate leave_type_id refers to an existing leave type
        db.get('SELECT id FROM leave_types WHERE id = ?', [leave_type_id], (err, leaveType) => {
            if (err || !leaveType) {
                db.close();
                req.session.message = { type: 'error', text: 'Invalid leave type.' };
                return res.redirect(redirectUrl);
            }
            
            db.run(`
                INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days, reason, status)
                VALUES (?, ?, ?, ?, ?, ?, 'Pending')
            `, [employee_id, leave_type_id, start_date, end_date, days, reason], (err) => {
                if (err) {
                    console.error('Error adding leave request:', err);
                    req.session.message = { type: 'error', text: 'Error adding leave request' };
                } else {
                    req.session.message = { type: 'success', text: 'Leave request added successfully!' };
                }
                
                db.close();
                res.redirect(redirectUrl);
            });
        });
        }); // close validateEmployeeExists
    }
}

// Approve/Reject Leave Request
function hrProcessLeaveRequest(req, res) {
    const db = getDbConnection();
    const leaveRequestId = req.params.id;
    const action = req.params.action; // approve or reject
    
    db.get('SELECT * FROM leave_requests WHERE id = ?', [leaveRequestId], (err, leaveRequest) => {
        if (err) {
            db.close();
            return res.status(500).send('Database error');
        }
        
        if (!leaveRequest) {
            db.close();
            return res.status(404).send('Leave request not found');
        }
        
        const newStatus = action === 'approve' ? 'Approved' : 'Rejected';
        
        db.run('BEGIN TRANSACTION', (err) => {
            if (err) {
                console.error('Error beginning transaction:', err);
                db.close();
                return res.status(500).send('Database error');
            }
            
            db.run(`
                UPDATE leave_requests SET
                    status = ?,
                    approved_by = ?,
                    approved_at = CURRENT_TIMESTAMP
                WHERE id = ? AND status = 'Pending'
            `, [newStatus, req.session.username, leaveRequestId], function(err) {
                if (err) {
                    console.error('Error processing leave request:', err);
                    db.run('ROLLBACK', () => {
                        db.close();
                        req.session.message = { type: 'error', text: 'Error processing leave request' };
                        res.redirect('/admin/hr/leave');
                    });
                    return;
                }
                
                if (this.changes === 0) {
                    db.run('ROLLBACK', () => {
                        db.close();
                        req.session.message = { type: 'error', text: 'Leave request has already been processed.' };
                        res.redirect('/admin/hr/leave');
                    });
                    return;
                }
                
                function commitAndNotify() {
                    db.run('COMMIT', (err) => {
                        if (err) {
                            console.error('Error committing transaction:', err);
                            db.run('ROLLBACK', () => {
                                db.close();
                                req.session.message = { type: 'error', text: 'Database error' };
                                res.redirect('/admin/hr/leave');
                            });
                            return;
                        }
                        
                        const notificationMessage = `Leave request ${newStatus.toLowerCase()} by ${req.session.username}`;
                        db.run(`
                            INSERT INTO admin_notifications (type, message, related_record_id, related_record_type, created_by, recipient, is_read, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
                        `, ['hr_leave_processed', notificationMessage, leaveRequestId, 'leave_request', req.session.username, req.session.username], function(notifErr) {
                            if (notifErr) {
                                console.error('[ERROR] Error creating HR leave processed notification:', notifErr);
                            } else {
                                notificationSSE.broadcast({
                                    id: this.lastID,
                                    type: 'hr_leave_processed',
                                    message: notificationMessage,
                                    related_record_id: leaveRequestId,
                                    related_record_type: 'leave_request',
                                    created_by: req.session.username,
                                    recipient: req.session.username,
                                    is_read: 0,
                                    created_at: new Date().toISOString()
                                });
                            }
                            
                            req.session.message = { type: 'success', text: `Leave request ${newStatus.toLowerCase()} successfully!` };
                            db.close();
                            res.redirect('/admin/hr/leave');
                        });
                    });
                }
                
                if (action === 'approve') {
                    const currentYear = new Date().getFullYear();
                    
                    db.get(`
                        SELECT * FROM leave_balances 
                        WHERE employee_id = ? AND leave_type_id = ? AND year = ?
                    `, [leaveRequest.employee_id, leaveRequest.leave_type_id, currentYear], (err, balance) => {
                        if (err) {
                            console.error('Error checking leave balance:', err);
                            db.run('ROLLBACK', () => {
                                db.close();
                                req.session.message = { type: 'error', text: 'Error checking leave balance.' };
                                res.redirect('/admin/hr/leave');
                            });
                            return;
                        }
                        
                        if (balance) {
                            db.run(`
                                UPDATE leave_balances SET
                                    used_days = used_days + ?,
                                    remaining_days = remaining_days - ?
                                WHERE id = ?
                                  AND remaining_days >= ?
                            `, [leaveRequest.days, leaveRequest.days, balance.id, leaveRequest.days], function(err) {
                                if (err) {
                                    console.error('Error updating leave balance:', err);
                                    db.run('ROLLBACK', () => {
                                        db.close();
                                        req.session.message = { type: 'error', text: 'Error updating leave balance.' };
                                        res.redirect('/admin/hr/leave');
                                    });
                                    return;
                                }
                                
                                if (this.changes === 0) {
                                    db.run('ROLLBACK', () => {
                                        db.close();
                                        req.session.message = { type: 'error', text: 'Insufficient leave balance for this request.' };
                                        res.redirect('/admin/hr/leave');
                                    });
                                    return;
                                }
                                
                                commitAndNotify();
                            });
                        } else {
                            db.get('SELECT default_days FROM leave_types WHERE id = ?', [leaveRequest.leave_type_id], (err, leaveType) => {
                                if (err || !leaveType) {
                                    console.error('Error getting leave type:', err);
                                    db.run('ROLLBACK', () => {
                                        db.close();
                                        req.session.message = { type: 'error', text: 'Error getting leave type.' };
                                        res.redirect('/admin/hr/leave');
                                    });
                                    return;
                                }
                                
                                if (leaveType.default_days < leaveRequest.days) {
                                    db.run('ROLLBACK', () => {
                                        db.close();
                                        req.session.message = { type: 'error', text: 'Insufficient leave balance for this request.' };
                                        res.redirect('/admin/hr/leave');
                                    });
                                    return;
                                }
                                
                                db.run(`
                                    INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, used_days, remaining_days)
                                    VALUES (?, ?, ?, ?, ?, ?)
                                `, [leaveRequest.employee_id, leaveRequest.leave_type_id, currentYear, leaveType.default_days, leaveRequest.days, leaveType.default_days - leaveRequest.days], (err) => {
                                    if (err) {
                                        console.error('Error creating leave balance:', err);
                                        db.run('ROLLBACK', () => {
                                            db.close();
                                            req.session.message = { type: 'error', text: 'Error creating leave balance.' };
                                            res.redirect('/admin/hr/leave');
                                        });
                                        return;
                                    }
                                    commitAndNotify();
                                });
                            });
                        }
                    });
                } else {
                    commitAndNotify();
                }
            });
        });
    });
}

// Leave Balances
function hrLeaveBalances(req, res) {
    const db = getDbConnection();
    const { employee_id } = req.query;

    // Gregorian → Jalali year helper using Intl Persian calendar (Jul 1 = dominant Jalali year)
    function gregorianToJalaliYear(gregorianYear) {
        try {
            var formatter = new Intl.DateTimeFormat('en-US-u-ca-persian', { year: 'numeric', calendar: 'persian' });
            var parts = formatter.formatToParts(new Date(gregorianYear, 6, 1));
            var y = parts.find(function(p) { return p.type === 'year'; });
            return y ? parseInt(y.value) : gregorianYear;
        } catch (e) {
            return gregorianYear;
        }
    }

    // Current Jalali year from existing helper
    var currentJalaliYear = parseInt(getCurrentJalaliDate().split('/')[0], 10);

    // Selected year from query (Jalali), default to current Jalali year
    var selectedJalaliYear = parseInt(req.query.year, 10) || currentJalaliYear;
    
    let query = `
        SELECT lb.*, e.full_name, e.employee_id, e.photo_path, lt.name as leave_type_name 
        FROM leave_balances lb 
        LEFT JOIN hr_employees e ON lb.employee_id = e.id 
        LEFT JOIN leave_types lt ON lb.leave_type_id = lt.id 
        WHERE lb.year = ?
    `;
    const params = [selectedJalaliYear];
    
    if (employee_id) {
        query += ` AND lb.employee_id = ?`;
        params.push(employee_id);
    }
    
    query += ' ORDER BY e.full_name ASC, lt.name ASC';
    
    db.all(query, params, (err, balances) => {
        if (err) {
            db.close();
            return res.status(500).send('Database error');
        }
        
        db.all('SELECT * FROM leave_types WHERE active = 1 ORDER BY name ASC', (err, leaveTypes) => {
            if (err) {
                db.close();
                return res.status(500).send('Database error');
            }
            
            db.all('SELECT DISTINCT year FROM leave_balances ORDER BY year DESC', (err, yearRows) => {
                if (err) {
                    db.close();
                    return res.status(500).send('Database error');
                }
                
                // Build Jalali year options from Gregorian years in DB
                var jalaliSet = {};
                var gregToJalMap = {};
                var jalToGregMap = {};
                yearRows.forEach(function(r) {
                    var jy = gregorianToJalaliYear(r.year);
                    jalaliSet[jy] = true;
                    gregToJalMap[r.year] = jy;
                    jalToGregMap[jy] = r.year;
                });
                if (!jalaliSet[currentJalaliYear]) {
                    jalaliSet[currentJalaliYear] = true;
                    jalToGregMap[currentJalaliYear] = new Date().getFullYear();
                }
                var yearOptions = Object.keys(jalaliSet).map(Number).sort(function(a, b) { return b - a; });

                // Convert selected Jalali year to Gregorian for DB query
                var selectedGregorianYear = jalToGregMap[selectedJalaliYear] || new Date().getFullYear();

                // Re-query with correct Gregorian year
                var finalQuery = `
                    SELECT lb.*, e.full_name, e.employee_id, e.photo_path, lt.name as leave_type_name 
                    FROM leave_balances lb 
                    LEFT JOIN hr_employees e ON lb.employee_id = e.id 
                    LEFT JOIN leave_types lt ON lb.leave_type_id = lt.id 
                    WHERE lb.year = ?
                `;
                var finalParams = [selectedGregorianYear];
                
                if (employee_id) {
                    finalQuery += ` AND lb.employee_id = ?`;
                    finalParams.push(employee_id);
                }
                
                finalQuery += ' ORDER BY e.full_name ASC, lt.name ASC';
                
                db.all(finalQuery, finalParams, (err, finalBalances) => {
                    if (err) {
                        db.close();
                        return res.status(500).send('Database error');
                    }

                    db.all('SELECT id, full_name FROM hr_employees WHERE employment_status = ? ORDER BY full_name ASC', ['Active'], (err, employees) => {
                        if (err) {
                            db.close();
                            return res.status(500).send('Database error');
                        }
                        
                        let contextEmployee = null;
                        if (employee_id) {
                            db.get('SELECT * FROM hr_employees WHERE id = ?', [employee_id], (err, emp) => {
                                if (err) {
                                    db.close();
                                    return res.status(500).send('Database error');
                                }
                                
                                if (!emp) {
                                    db.close();
                                    return res.status(404).send('Employee not found');
                                }
                                
                                contextEmployee = emp;
                                db.close();
                                
                                res.render('hr/leave-balances', {
                                    balances: finalBalances,
                                    leaveTypes,
                                    currentYear: selectedJalaliYear,
                                    contextEmployee,
                                    filters: { employee_id: employee_id || '', year: selectedJalaliYear },
                                    yearOptions,
                                    employees,
                                    session: req.session
                                });
                            });
                        } else {
                            db.close();
                            
                            res.render('hr/leave-balances', {
                                balances: finalBalances,
                                leaveTypes,
                                currentYear: selectedJalaliYear,
                                contextEmployee,
                                filters: { employee_id: employee_id || '', year: selectedJalaliYear },
                                yearOptions,
                                employees,
                                session: req.session
                            });
                        }
                    });
                });
            });
        });
    });
}

// Employee Documents
function hrDocuments(req, res) {
    const db = getDbConnection();
    const { employee_id, category } = req.query;
    
    // C4.4: Category-to-type mapping
    const CATEGORY_TYPE_MAP = {
        'tazkira_passport': [4, 8],
        'cv': [7],
        'degrees_certificates': [2, 5],
        'other': [3]
    };
    const CATEGORY_LABELS = {
        'tazkira_passport': 'hr.documents.cat_tazkira_passport',
        'cv': 'hr.documents.cat_cv',
        'degrees_certificates': 'hr.documents.cat_degrees_certificates',
        'other': 'hr.documents.cat_other'
    };
    const TYPE_TO_CATEGORY = {};
    Object.keys(CATEGORY_TYPE_MAP).forEach(function(cat) {
        CATEGORY_TYPE_MAP[cat].forEach(function(typeId) {
            TYPE_TO_CATEGORY[typeId] = cat;
        });
    });

    let query = `
        SELECT ed.*, e.full_name, e.employee_id AS emp_display_id, e.photo_path, dt.name as document_type_name 
        FROM employee_documents ed 
        LEFT JOIN hr_employees e ON ed.employee_id = e.id 
        LEFT JOIN document_types dt ON ed.document_type_id = dt.id 
    `;
    const conditions = [];
    const params = [];
    
    if (employee_id) {
        conditions.push('ed.employee_id = ?');
        params.push(employee_id);
    }
    // M7/C4.4: Object.hasOwn blocks prototype-chain keys (__proto__, constructor)
    if (category && Object.hasOwn(CATEGORY_TYPE_MAP, category)) {
        const typeIds = CATEGORY_TYPE_MAP[category];
        conditions.push('ed.document_type_id IN (' + typeIds.join(',') + ')');
    }
    
    if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY ed.created_at DESC';
    
    db.all(query, params, (err, documents) => {
        if (err) {
            db.close();
            return res.status(500).send('Database error');
        }

        // C4.4: Categorize each document
        if (documents) {
            documents.forEach(function(doc) {
                doc.logical_category = TYPE_TO_CATEGORY[doc.document_type_id] || 'other';
                doc.category_label_key = CATEGORY_LABELS[doc.logical_category] || 'hr.documents.cat_other';
            });
        }

        // C4.4/C4.5: Always fetch employee list for dropdown + cards (even when filtering by employee)
        db.all(`SELECT e.id, e.employee_id, e.full_name, e.position, e.contract_type, e.hire_date, e.employment_end_date, e.photo_path, d.name AS department_name FROM hr_employees e LEFT JOIN departments d ON e.department_id = d.id WHERE e.employment_status = 'Active' ORDER BY e.full_name ASC`, (err, employees) => {
            if (err) {
                db.close();
                return res.status(500).send('Database error');
            }

            db.all('SELECT * FROM document_types WHERE active = 1 ORDER BY name ASC', (err, documentTypes) => {
                if (err) {
                    db.close();
                    return res.status(500).send('Database error');
                }

                if (!employees || employees.length === 0) {
                    db.close();
                    res.render('hr/documents', {
                        documents: documents || [],
                        documentsByEmployee: {},
                        employees: [],
                        cardEmployees: [],
                        documentTypes,
                        contextEmployee: null,
                        filters: { employee_id, category },
                        session: req.session
                    });
                    return;
                }

                const currentJalali = getCurrentJalaliDate();
                let pending = employees.length;
                employees.forEach(function(emp) {
                    db.get(`SELECT basic_salary, allowances FROM employee_salary_history WHERE employee_id = ? AND (effective_to IS NULL OR effective_to >= ?) ORDER BY effective_from DESC LIMIT 1`, [emp.id, currentJalali], (salErr, salaryRow) => {
                        emp.monthly_salary = (!salErr && salaryRow) ? ((salaryRow.basic_salary || 0) + (salaryRow.allowances || 0)) : null;
                        pending--;
                        if (pending === 0) {
                            // C4.5: Group documents by employee_id for employee-centric card layout
                            var docsByEmp = {};
                            if (documents && documents.length > 0) {
                                documents.forEach(function(doc) {
                                    var eid = doc.employee_id;
                                    if (!docsByEmp[eid]) { docsByEmp[eid] = []; }
                                    docsByEmp[eid].push(doc);
                                });
                            }
                            var cardEmployees = employee_id
                                ? employees.filter(function(e) { return String(e.id) === String(employee_id); })
                                : employees;

                            db.close();
                            res.render('hr/documents', {
                                documents: documents || [],
                                documentsByEmployee: docsByEmp,
                                employees,
                                cardEmployees: cardEmployees,
                                documentTypes,
                                contextEmployee: null,
                                filters: { employee_id, category },
                                session: req.session
                            });
                        }
                    });
                });
            });
        });
    });
}

// Add Document
function hrAddDocument(req, res) {
    const db = getDbConnection();
    
    if (req.method === 'POST') {
        const { employee_id, document_type_id, document_number, issue_date, expiry_date, notes, context_employee_id } = req.body;
        
        validateEmployeeExists(db, employee_id, (empErr) => {
            if (empErr) {
                db.close();
                req.session.message = { type: 'error', text: empErr.message };
                const redirectUrl = context_employee_id ? `/admin/hr/documents?employee_id=${context_employee_id}` : '/admin/hr/documents';
                return res.redirect(redirectUrl);
            }
        
        db.run(`
            INSERT INTO employee_documents (employee_id, document_type_id, document_number, issue_date, expiry_date, notes, uploaded_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [employee_id, document_type_id, document_number, issue_date, expiry_date, notes, req.session.username], (err) => {
            if (err) {
                console.error('Error adding document:', err);
                req.session.message = { type: 'error', text: 'Error adding document' };
            } else {
                req.session.message = { type: 'success', text: 'Document added successfully!' };
            }
            
            db.close();
            const redirectUrl = context_employee_id ? `/admin/hr/documents?employee_id=${context_employee_id}` : '/admin/hr/documents';
            res.redirect(redirectUrl);
        });
        }); // close validateEmployeeExists
    }
}

// Phase 6.0 — Attendance calculation helpers
function calculateLateMinutes(actualCheckIn, expectedCheckIn, gracePeriodMinutes) {
    if (!actualCheckIn || !expectedCheckIn) return 0;
    const actual = timeToMinutes(actualCheckIn);
    const expected = timeToMinutes(expectedCheckIn);
    const diff = actual - expected - (gracePeriodMinutes || 0);
    return diff > 0 ? diff : 0;
}

function calculateEarlyDepartureMinutes(actualCheckOut, expectedCheckOut) {
    if (!actualCheckOut || !expectedCheckOut) return 0;
    const actual = timeToMinutes(actualCheckOut);
    const expected = timeToMinutes(expectedCheckOut);
    const diff = expected - actual;
    return diff > 0 ? diff : 0;
}

function timeToMinutes(timeStr) {
    if (!timeStr) return 0;
    const parts = timeStr.split(':');
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

function isValidAttendanceDate(value) {
    return typeof value === 'string' && /^\d{4}\/\d{2}\/\d{2}$/.test(value.trim());
}

function attendanceRedirectUrl(date, extraKey, extraValue) {
    const params = [];
    if (isValidAttendanceDate(date)) {
        params.push('date=' + encodeURIComponent(date.trim()));
    }
    if (extraKey && extraValue) {
        params.push(extraKey + '=' + encodeURIComponent(extraValue));
    }
    return '/admin/hr/attendance' + (params.length ? '?' + params.join('&') : '');
}

// Phase 6.1 — Daily Attendance Operations Dashboard
function hrAttendance(req, res) {
    const db = getDbConnection();
    const today = getCurrentJalaliDate();
    const { date: rawDate, search, department_id, status } = req.query;
    const selectedDate = rawDate || today;
    const prefill = req.query.prefill === '1';

    // Build employee query with LEFT JOIN attendance for selected date
    // Uses EXISTS subquery for leave status to avoid row duplication
    let empQuery = `
        SELECT
            e.id, e.employee_id, e.full_name, e.position, e.photo_path,
            d.name AS department_name, d.id AS dept_id,
            ws.name AS schedule_name, ws.expected_check_in, ws.expected_check_out,
            a.id AS att_id,
            COALESCE(a.status,
                CASE WHEN EXISTS(
                    SELECT 1 FROM leave_requests lr
                    WHERE lr.employee_id = e.id
                      AND lr.status = 'Approved'
                      AND REPLACE(lr.start_date, ' ', '') <= ?
                      AND REPLACE(lr.end_date, ' ', '') >= ?
                ) THEN 'Leave' END
            ) AS att_status,
            a.check_in, a.check_out,
            a.late_minutes, a.early_departure_minutes, a.source AS att_source, a.notes AS att_notes
        FROM hr_employees e
        LEFT JOIN departments d ON e.department_id = d.id
        LEFT JOIN work_schedules ws ON e.work_schedule_id = ws.id
        LEFT JOIN attendance a ON a.employee_id = e.id AND a.attendance_date = ?
        WHERE e.employment_status = 'Active'
    `;
    const params = [selectedDate, selectedDate, selectedDate];

    if (search) {
        empQuery += ` AND (e.full_name LIKE ? ESCAPE '\\' OR e.employee_id LIKE ? ESCAPE '\\')`;
        const term = likeContains(search);
        params.push(term, term);
    }
    if (department_id) {
        empQuery += ` AND e.department_id = ?`;
        params.push(department_id);
    }

    empQuery += ` ORDER BY e.full_name ASC`;

    db.all(empQuery, params, (err, rows) => {
        if (err) {
            console.error('hrAttendance error:', err);
            db.close();
            req.session.message = { type: 'error', text: 'Database error loading attendance dashboard.' };
            return res.redirect('/admin/hr');
        }

        // Apply status filter in JS (only show rows matching status filter)
        let employees = rows || [];
        if (status) {
            employees = employees.filter(r => {
                if (!r.att_id && status === 'missing') return r.att_status !== 'Leave';
                return r.att_status === status;
            });
        }

        // Summary stats (computed from ALL active employees, not filtered subset)
        const allRows = rows || [];
        const total = allRows.length;
        const recorded = allRows.filter(r => r.att_id !== null).length;
        const present = allRows.filter(r => r.att_status === 'Present').length;
        const absent = allRows.filter(r => r.att_status === 'Absent').length;
        const leaveCount = allRows.filter(r => r.att_status === 'Leave').length;
        const lateCount = allRows.filter(r => r.late_minutes > 0).length;
        const earlyCount = allRows.filter(r => r.early_departure_minutes > 0).length;
        const missing = total - recorded - leaveCount;

        const summary = { total, recorded, missing, present, absent, leave: leaveCount, late: lateCount, early: earlyCount };

        // Previous / Next Jalali dates
        const dateParts = selectedDate.split('/');
        const prevDay = subtractOneJalaliDay(parseInt(dateParts[0]), parseInt(dateParts[1]), parseInt(dateParts[2]));
        const nextDay = addOneJalaliDay(parseInt(dateParts[0]), parseInt(dateParts[1]), parseInt(dateParts[2]));
        const prevDate = `${prevDay.year}/${String(prevDay.month).padStart(2, '0')}/${String(prevDay.day).padStart(2, '0')}`;
        const nextDate = `${nextDay.year}/${String(nextDay.month).padStart(2, '0')}/${String(nextDay.day).padStart(2, '0')}`;

        // Departments for filter
        db.all('SELECT id, name FROM departments ORDER BY name ASC', (dErr, departments) => {
            db.close();
            res.render('hr/attendance', {
                employees,
                summary,
                selectedDate,
                prevDate,
                nextDate,
                today,
                departments: departments || [],
                filters: { search: search || '', department_id: department_id || '', status: status || '' },
                prefill,
                session: req.session
            });
        });
    });
}

// Add Attendance
function hrAddAttendance(req, res) {
    const db = getDbConnection();

    if (req.method === 'POST') {
        const { employee_id, attendance_date, status, check_in, check_out, notes, context_employee_id } = req.body;
        const validStatuses = ['Present', 'Absent', 'Late', 'Half Day', 'Holiday', 'Leave'];
        const contextKey = context_employee_id ? 'employee_id' : null;

        if (!attendance_date || !isValidAttendanceDate(attendance_date)) {
            db.close();
            req.session.message = { type: 'error', text: attendance_date ? 'Invalid date.' : 'Date is required.' };
            return res.redirect(attendanceRedirectUrl(null, contextKey, context_employee_id));
        }
        if (!status || !validStatuses.includes(status)) {
            db.close();
            req.session.message = { type: 'error', text: 'Invalid status.' };
            return res.redirect(attendanceRedirectUrl(attendance_date, contextKey, context_employee_id));
        }
        if (['Present', 'Late', 'Half Day'].includes(status) && !(check_in && String(check_in).trim())) {
            db.close();
            req.session.message = { type: 'error', text: 'Check-in time is required for Present, Late, and Half Day.' };
            return res.redirect(attendanceRedirectUrl(attendance_date, contextKey, context_employee_id));
        }

        validateEmployeeExists(db, employee_id, (empErr) => {
            if (empErr) {
                db.close();
                req.session.message = { type: 'error', text: empErr.message };
                return res.redirect(attendanceRedirectUrl(attendance_date, contextKey, context_employee_id));
            }

            db.get(`
                SELECT ws.expected_check_in, ws.expected_check_out, ws.grace_period_minutes
                FROM hr_employees e
                LEFT JOIN work_schedules ws ON e.work_schedule_id = ws.id
                WHERE e.id = ?
            `, [employee_id], (schedErr, schedule) => {
                let late_minutes = 0;
                let early_departure_minutes = 0;

                if (!schedErr && schedule && schedule.expected_check_in && check_in) {
                    late_minutes = calculateLateMinutes(check_in, schedule.expected_check_in, schedule.grace_period_minutes || 0);
                }
                if (!schedErr && schedule && schedule.expected_check_out && check_out) {
                    early_departure_minutes = calculateEarlyDepartureMinutes(check_out, schedule.expected_check_out);
                }

                db.run(`
                    INSERT INTO attendance (employee_id, attendance_date, status, check_in, check_out, late_minutes, early_departure_minutes, overtime_hours, notes, source)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'MANUAL')
                `, [employee_id, attendance_date, status, check_in, check_out, late_minutes, early_departure_minutes, notes], (err) => {
                    if (err) {
                        console.error('Error adding attendance:', err);
                        req.session.message = { type: 'error', text: 'Error adding attendance' };
                    } else {
                        req.session.message = { type: 'success', text: 'Attendance added successfully!' };
                    }

                    db.close();
                    res.redirect(attendanceRedirectUrl(attendance_date, contextKey, context_employee_id));
                });
            });
        });
    }
}

// Phase 6.0 — Bulk Attendance
function hrBulkAttendance(req, res) {
    const db = getDbConnection();

    if (req.method === 'POST') {
        const { attendance_date, employee_ids, statuses, check_ins, check_outs, notes } = req.body;

        if (!attendance_date) {
            db.close();
            req.session.message = { type: 'error', text: 'Date is required.' };
            return res.redirect('/admin/hr/attendance');
        }
        if (!isValidAttendanceDate(attendance_date)) {
            db.close();
            req.session.message = { type: 'error', text: 'Invalid date.' };
            return res.redirect('/admin/hr/attendance');
        }

        const rawIds = Array.isArray(employee_ids) ? employee_ids : (employee_ids ? [employee_ids] : []);
        const stats = Array.isArray(statuses) ? statuses : (statuses ? [statuses] : []);
        const ins = Array.isArray(check_ins) ? check_ins : (check_ins ? [check_ins] : []);
        const outs = Array.isArray(check_outs) ? check_outs : (check_outs ? [check_outs] : []);
        const notesArr = Array.isArray(notes) ? notes : (notes ? [notes] : []);
        const validStatuses = ['Present', 'Absent', 'Late', 'Half Day', 'Holiday', 'Leave'];

        if (rawIds.length === 0) {
            db.close();
            req.session.message = { type: 'error', text: 'No employees selected.' };
            return res.redirect(attendanceRedirectUrl(attendance_date));
        }

        const firstIdx = new Map();
        const uniqueIds = [];
        rawIds.forEach((raw, idx) => {
            const empId = parseInt(raw) || raw;
            if (!firstIdx.has(empId)) {
                firstIdx.set(empId, idx);
                uniqueIds.push(empId);
            }
        });

        const placeholders = uniqueIds.map(() => '?').join(',');
        db.all(`SELECT id FROM hr_employees WHERE id IN (${placeholders}) AND employment_status = 'Active'`, uniqueIds, (vErr, validEmps) => {
            if (vErr) {
                db.close();
                req.session.message = { type: 'error', text: 'Validation error.' };
                return res.redirect(attendanceRedirectUrl(attendance_date));
            }

            const validIds = new Set((validEmps || []).map(e => e.id));
            let created = 0, updated = 0, skipped = 0, failed = 0, invalid = 0;
            let processed = 0;
            const total = uniqueIds.length;

            const finish = () => {
                db.close();
                const text = `Bulk attendance: ${created} created, ${updated} updated, ${skipped} skipped, ${failed} failed, ${invalid} invalid.`;
                req.session.message = { type: failed > 0 ? 'error' : 'success', text };
                res.redirect(attendanceRedirectUrl(attendance_date));
            };

            uniqueIds.forEach((empId) => {
                if (!validIds.has(empId)) {
                    invalid++;
                    processed++;
                    if (processed === total) finish();
                    return;
                }

                const idx = firstIdx.get(empId);
                const empStatus = (stats[idx] || '').trim();
                const empCheckIn = (ins[idx] || '').trim() || null;
                const empCheckOut = (outs[idx] || '').trim() || null;
                const empNotes = (notesArr[idx] || '').trim() || null;

                if (!empStatus || !validStatuses.includes(empStatus)) {
                    invalid++;
                    processed++;
                    if (processed === total) finish();
                    return;
                }
                if (['Present', 'Late', 'Half Day'].includes(empStatus) && !empCheckIn) {
                    invalid++;
                    processed++;
                    if (processed === total) finish();
                    return;
                }

                db.get('SELECT id FROM attendance WHERE employee_id = ? AND attendance_date = ?', [empId, attendance_date], (exErr, existing) => {
                    if (exErr) {
                        failed++;
                        processed++;
                        if (processed === total) finish();
                        return;
                    }
                    if (existing) {
                        skipped++;
                        processed++;
                        if (processed === total) finish();
                        return;
                    }

                    db.get(`
                        SELECT ws.expected_check_in, ws.expected_check_out, ws.grace_period_minutes
                        FROM hr_employees e
                        LEFT JOIN work_schedules ws ON e.work_schedule_id = ws.id
                        WHERE e.id = ?
                    `, [empId], (schedErr, schedule) => {
                        let late_minutes = 0;
                        let early_departure_minutes = 0;
                        if (!schedErr && schedule && schedule.expected_check_in && empCheckIn) {
                            late_minutes = calculateLateMinutes(empCheckIn, schedule.expected_check_in, schedule.grace_period_minutes || 0);
                        }
                        if (!schedErr && schedule && schedule.expected_check_out && empCheckOut) {
                            early_departure_minutes = calculateEarlyDepartureMinutes(empCheckOut, schedule.expected_check_out);
                        }

                        db.run(`
                            INSERT INTO attendance (employee_id, attendance_date, status, check_in, check_out, late_minutes, early_departure_minutes, overtime_hours, notes, source)
                            VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'MANUAL')
                        `, [empId, attendance_date, empStatus, empCheckIn, empCheckOut, late_minutes, early_departure_minutes, empNotes], (insErr) => {
                            if (insErr) {
                                if (insErr.message && insErr.message.includes('UNIQUE')) {
                                    skipped++;
                                } else {
                                    failed++;
                                }
                            } else {
                                created++;
                            }
                            processed++;
                            if (processed === total) finish();
                        });
                    });
                });
            });
        });
    } else {
        res.redirect('/admin/hr/attendance');
    }
}

// Phase 6.0 — Edit Attendance (show form)
function hrEditAttendance(req, res) {
    const db = getDbConnection();
    const { id } = req.params;
    
    db.get(`
        SELECT a.*, e.full_name, e.employee_id as emp_code, ws.expected_check_in, ws.expected_check_out, ws.grace_period_minutes
        FROM attendance a
        LEFT JOIN hr_employees e ON a.employee_id = e.id
        LEFT JOIN work_schedules ws ON e.work_schedule_id = ws.id
        WHERE a.id = ?
    `, [id], (err, record) => {
        if (err || !record) {
            db.close();
            req.session.message = { type: 'error', text: 'Attendance record not found.' };
            return res.redirect('/admin/hr/attendance');
        }
        
        db.all('SELECT id, full_name FROM hr_employees WHERE employment_status = "Active" ORDER BY full_name ASC', (empErr, employees) => {
            db.close();
            res.render('hr/attendance-edit', {
                record,
                employees: employees || [],
                session: req.session
            });
        });
    });
}

// Phase 6.0 — Update Attendance (save edit)
function hrUpdateAttendance(req, res) {
    const db = getDbConnection();
    const { id } = req.params;
    const { employee_id, attendance_date, status, check_in, check_out, notes } = req.body;
    const validStatuses = ['Present', 'Absent', 'Late', 'Half Day', 'Holiday', 'Leave'];

    if (!attendance_date || !isValidAttendanceDate(attendance_date)) {
        db.close();
        req.session.message = { type: 'error', text: attendance_date ? 'Invalid date.' : 'Date is required.' };
        return res.redirect('/admin/hr/attendance');
    }
    if (!status || !validStatuses.includes(status)) {
        db.close();
        req.session.message = { type: 'error', text: 'Invalid status.' };
        return res.redirect(attendanceRedirectUrl(attendance_date));
    }
    if (['Present', 'Late', 'Half Day'].includes(status) && !(check_in && String(check_in).trim())) {
        db.close();
        req.session.message = { type: 'error', text: 'Check-in time is required for Present, Late, and Half Day.' };
        return res.redirect(attendanceRedirectUrl(attendance_date));
    }

    validateEmployeeExists(db, employee_id, (empErr) => {
        if (empErr) {
            db.close();
            req.session.message = { type: 'error', text: empErr.message };
            return res.redirect(attendanceRedirectUrl(attendance_date));
        }

        db.get('SELECT id FROM attendance WHERE id = ?', [id], (exErr, existing) => {
            if (exErr || !existing) {
                db.close();
                req.session.message = { type: 'error', text: exErr ? 'Validation error.' : 'Attendance record not found.' };
                return res.redirect(attendanceRedirectUrl(attendance_date));
            }

            db.get(`
                SELECT ws.expected_check_in, ws.expected_check_out, ws.grace_period_minutes
                FROM hr_employees e
                LEFT JOIN work_schedules ws ON e.work_schedule_id = ws.id
                WHERE e.id = ?
            `, [employee_id], (schedErr, schedule) => {
                let late_minutes = 0, early_departure_minutes = 0;
                if (!schedErr && schedule && schedule.expected_check_in && check_in) {
                    late_minutes = calculateLateMinutes(check_in, schedule.expected_check_in, schedule.grace_period_minutes || 0);
                }
                if (!schedErr && schedule && schedule.expected_check_out && check_out) {
                    early_departure_minutes = calculateEarlyDepartureMinutes(check_out, schedule.expected_check_out);
                }

                db.run(`
                    UPDATE attendance SET employee_id = ?, attendance_date = ?, status = ?, check_in = ?, check_out = ?,
                    late_minutes = ?, early_departure_minutes = ?, notes = ?
                    WHERE id = ?
                `, [employee_id, attendance_date, status, check_in, check_out, late_minutes, early_departure_minutes, notes, id], (err) => {
                    if (err) {
                        console.error('Error updating attendance:', err);
                        req.session.message = { type: 'error', text: 'Error updating attendance' };
                    } else {
                        req.session.message = { type: 'success', text: 'Attendance updated successfully!' };
                    }
                    db.close();
                    res.redirect(attendanceRedirectUrl(attendance_date));
                });
            });
        });
    });
}

// Phase 6.0 — Work Schedules
function hrWorkSchedules(req, res) {
    const db = getDbConnection();
    db.all('SELECT * FROM work_schedules ORDER BY name ASC', (err, schedules) => {
        db.close();
        if (err) {
            req.session.message = { type: 'error', text: 'Error loading schedules.' };
            return res.redirect('/admin/hr');
        }
        res.render('hr/work-schedules', { schedules: schedules || [], session: req.session });
    });
}

function hrAddWorkSchedule(req, res) {
    const db = getDbConnection();
    if (req.method === 'POST') {
        const { name, expected_check_in, expected_check_out, grace_period_minutes, working_days } = req.body;
        if (!name || !expected_check_in || !expected_check_out) {
            db.close();
            req.session.message = { type: 'error', text: 'Name, check-in time, and check-out time are required.' };
            return res.redirect('/admin/hr/schedules');
        }
        db.run(`
            INSERT INTO work_schedules (name, expected_check_in, expected_check_out, grace_period_minutes, working_days)
            VALUES (?, ?, ?, ?, ?)
        `, [name, expected_check_in, expected_check_out, parseInt(grace_period_minutes, 10) || 10, working_days || '1,2,3,4,5'], (err) => {
            if (err) {
                req.session.message = { type: 'error', text: 'Error creating schedule' };
            } else {
                req.session.message = { type: 'success', text: 'Schedule created successfully!' };
            }
            db.close();
            res.redirect('/admin/hr/schedules');
        });
    } else {
        db.close();
        res.redirect('/admin/hr/schedules');
    }
}

function hrDeleteWorkSchedule(req, res) {
    const db = getDbConnection();
    const { id } = req.params;
    // Check if any employees use this schedule
    db.get('SELECT COUNT(*) as cnt FROM hr_employees WHERE work_schedule_id = ?', [id], (cntErr, row) => {
        if (row && row.cnt > 0) {
            db.close();
            req.session.message = { type: 'error', text: 'Cannot delete schedule: ' + row.cnt + ' employee(s) are using it.' };
            return res.redirect('/admin/hr/schedules');
        }
        db.run('DELETE FROM work_schedules WHERE id = ?', [id], (err) => {
            if (err) {
                req.session.message = { type: 'error', text: 'Error deleting schedule.' };
            } else {
                req.session.message = { type: 'success', text: 'Schedule deleted.' };
            }
            db.close();
            res.redirect('/admin/hr/schedules');
        });
    });
}

// Phase 6.2 — Edit Work Schedule
function hrEditWorkSchedule(req, res) {
    const db = getDbConnection();
    const { id } = req.params;

    if (req.method === 'POST') {
        const { name, expected_check_in, expected_check_out, grace_period_minutes, working_days } = req.body;
        if (!name || !expected_check_in || !expected_check_out) {
            db.close();
            req.session.message = { type: 'error', text: 'Name, check-in time, and check-out time are required.' };
            return res.redirect(`/admin/hr/schedules/${id}/edit`);
        }
        db.run(`
            UPDATE work_schedules SET name = ?, expected_check_in = ?, expected_check_out = ?, grace_period_minutes = ?, working_days = ?
            WHERE id = ?
        `, [name, expected_check_in, expected_check_out, parseInt(grace_period_minutes, 10) || 10, working_days || '1,2,3,4,5', id], (err) => {
            if (err) {
                req.session.message = { type: 'error', text: 'Error updating schedule' };
            } else {
                req.session.message = { type: 'success', text: 'Schedule updated successfully!' };
            }
            db.close();
            res.redirect('/admin/hr/schedules');
        });
    } else {
        db.get('SELECT * FROM work_schedules WHERE id = ?', [id], (err, schedule) => {
            if (err || !schedule) {
                db.close();
                req.session.message = { type: 'error', text: 'Schedule not found.' };
                return res.redirect('/admin/hr/schedules');
            }
            db.close();
            res.render('hr/schedule-edit', { schedule, session: req.session });
        });
    }
}

// Phase 6.1 — Mark All Present (INSERT OR IGNORE)
function hrMarkAllPresent(req, res) {
    const { date } = req.body;
    if (!date || !isValidAttendanceDate(date)) {
        req.session.message = { type: 'error', text: date ? 'Invalid date.' : 'Date is required.' };
        return res.redirect('/admin/hr/attendance');
    }
    return res.redirect('/admin/hr/attendance?date=' + encodeURIComponent(date.trim()) + '&prefill=1');
}

// Phase 6.1 — Bulk Status Apply
function hrBulkStatusApply(req, res) {
    const db = getDbConnection();
    const { date, employee_ids, status } = req.body;

    if (!date || !isValidAttendanceDate(date)) {
        db.close();
        req.session.message = { type: 'error', text: date ? 'Invalid date.' : 'Date is required.' };
        return res.redirect('/admin/hr/attendance');
    }

    const validStatuses = ['Present', 'Absent', 'Late', 'Half Day', 'Holiday', 'Leave'];
    if (!status || !validStatuses.includes(status)) {
        db.close();
        req.session.message = { type: 'error', text: 'Invalid status.' };
        return res.redirect(attendanceRedirectUrl(date));
    }

    const rawIds = Array.isArray(employee_ids) ? employee_ids : (employee_ids ? [employee_ids] : []);
    const ids = Array.from(new Set(rawIds.map(v => parseInt(v) || v)));
    if (ids.length === 0) {
        db.close();
        req.session.message = { type: 'error', text: 'No employees selected.' };
        return res.redirect(attendanceRedirectUrl(date));
    }

    const placeholders = ids.map(() => '?').join(',');
    db.all(`SELECT id FROM hr_employees WHERE id IN (${placeholders}) AND employment_status = 'Active'`, ids, (vErr, validEmps) => {
        if (vErr) {
            db.close();
            req.session.message = { type: 'error', text: 'Validation error.' };
            return res.redirect(attendanceRedirectUrl(date));
        }

        const validIds = new Set((validEmps || []).map(e => e.id));
        const toProcess = ids.filter(id => validIds.has(id));
        const invalid = ids.length - toProcess.length;
        const total = toProcess.length;
        let created = 0, updated = 0, skipped = 0, failed = 0;
        let processed = 0;
        let skipMissingCheckIn = 0, skipNoEvidence = 0, skipDuplicate = 0;

        const finish = () => {
            db.close();
            const reasons = [];
            if (skipMissingCheckIn > 0) reasons.push(skipMissingCheckIn + ' missing check-in');
            if (skipNoEvidence > 0) reasons.push(skipNoEvidence + ' no evidence');
            if (skipDuplicate > 0) reasons.push(skipDuplicate + ' duplicate');
            const skipDetail = reasons.length ? ' (' + reasons.join(', ') + ')' : '';
            let text = `Bulk status: ${created} created, ${updated} updated, ${skipped} skipped${skipDetail}, ${failed} failed`;
            if (invalid > 0) text += `, ${invalid} invalid`;
            text += '.';
            req.session.message = { type: failed > 0 ? 'error' : 'success', text };
            res.redirect(attendanceRedirectUrl(date));
        };

        if (total === 0) {
            finish();
            return;
        }

        toProcess.forEach(empId => {
            db.get('SELECT id, check_in, check_out FROM attendance WHERE employee_id = ? AND attendance_date = ?', [empId, date], (exErr, existing) => {
                if (exErr) {
                    failed++;
                    processed++;
                    if (processed === total) finish();
                    return;
                }

                if (existing) {
                    if (['Present', 'Late', 'Half Day'].includes(status) && !existing.check_in) {
                        skipped++;
                        skipMissingCheckIn++;
                        processed++;
                        if (processed === total) finish();
                        return;
                    }

                    db.get(`
                        SELECT ws.expected_check_in, ws.expected_check_out, ws.grace_period_minutes
                        FROM hr_employees e
                        LEFT JOIN work_schedules ws ON e.work_schedule_id = ws.id
                        WHERE e.id = ?
                    `, [empId], (schedErr, schedule) => {
                        let late_minutes = 0, early_departure_minutes = 0;
                        if (!schedErr && schedule && schedule.expected_check_in && existing.check_in) {
                            late_minutes = calculateLateMinutes(existing.check_in, schedule.expected_check_in, schedule.grace_period_minutes || 0);
                        }
                        if (!schedErr && schedule && schedule.expected_check_out && existing.check_out) {
                            early_departure_minutes = calculateEarlyDepartureMinutes(existing.check_out, schedule.expected_check_out);
                        }

                        db.run(`
                            UPDATE attendance SET status = ?, late_minutes = ?, early_departure_minutes = ?
                            WHERE id = ?
                        `, [status, late_minutes, early_departure_minutes, existing.id], (uErr) => {
                            if (uErr) {
                                failed++;
                            } else {
                                updated++;
                            }
                            processed++;
                            if (processed === total) finish();
                        });
                    });
                } else {
                    if (['Present', 'Late', 'Half Day'].includes(status)) {
                        skipped++;
                        skipNoEvidence++;
                        processed++;
                        if (processed === total) finish();
                        return;
                    }

                    db.run(`
                        INSERT INTO attendance (employee_id, attendance_date, status, check_in, check_out, late_minutes, early_departure_minutes, overtime_hours, notes, source)
                        VALUES (?, ?, ?, NULL, NULL, 0, 0, 0, NULL, 'MANUAL')
                    `, [empId, date, status], (insErr) => {
                        if (insErr) {
                            if (insErr.message && insErr.message.includes('UNIQUE')) {
                                skipped++;
                                skipDuplicate++;
                            } else {
                                failed++;
                            }
                        } else {
                            created++;
                        }
                        processed++;
                        if (processed === total) finish();
                    });
                }
            });
        });
    });
}

// Overtime
function hrOvertime(req, res) {
    const db = getDbConnection();
    const { employee_id } = req.query;
    
    let query = `
        SELECT o.*, e.full_name, e.employee_id, e.position, e.photo_path
        FROM overtime o 
        LEFT JOIN hr_employees e ON o.employee_id = e.id 
    `;
    const params = [];
    
    if (employee_id) {
        query += ` WHERE o.employee_id = ?`;
        params.push(employee_id);
    }
    
    query += ' ORDER BY o.created_at DESC';
    
    db.all(query, params, (err, overtimeRecords) => {
        if (err) {
            db.close();
            return res.status(500).send('Database error');
        }
        
        let contextEmployee = null;
        if (employee_id) {
            db.get('SELECT * FROM hr_employees WHERE id = ?', [employee_id], (err, emp) => {
                if (err) {
                    db.close();
                    return res.status(500).send('Database error');
                }
                
                if (!emp) {
                    db.close();
                    return res.status(404).send('Employee not found');
                }
                
                contextEmployee = emp;
                
                db.all('SELECT id, full_name FROM hr_employees WHERE employment_status = "Active" ORDER BY full_name ASC', (err, employees) => {
                    if (err) {
                        db.close();
                        return res.status(500).send('Database error');
                    }
                    
                    db.close();
                    res.render('hr/overtime', {
                        overtimeRecords,
                        employees,
                        contextEmployee,
                        filters: { employee_id },
                        session: req.session
                    });
                });
            });
        } else {
            db.all('SELECT id, full_name FROM hr_employees WHERE employment_status = "Active" ORDER BY full_name ASC', (err, employees) => {
                db.close();
                if (err) {
                    return res.status(500).send('Database error');
                }
                
                res.render('hr/overtime', {
                    overtimeRecords,
                    employees,
                    contextEmployee,
                    filters: { employee_id },
                    session: req.session
                });
            });
        }
    });
}

// Add Overtime
function hrAddOvertime(req, res) {
    const db = getDbConnection();
    
    if (req.method === 'POST') {
        const { employee_id, overtime_date, hours, rate, reason, context_employee_id } = req.body;
        
        const parsedHours = parseFloat(hours);
        const parsedRate = parseFloat(rate);
        
        if (isNaN(parsedHours) || parsedHours < 0) {
            db.close();
            req.session.message = { type: 'error', text: 'Invalid overtime hours. Must be a non-negative number.' };
            const redirectUrl = context_employee_id ? `/admin/hr/overtime?employee_id=${context_employee_id}` : '/admin/hr/overtime';
            return res.redirect(redirectUrl);
        }
        
        if (isNaN(parsedRate) || parsedRate < 0) {
            db.close();
            req.session.message = { type: 'error', text: 'Invalid overtime rate. Must be a non-negative number.' };
            const redirectUrl = context_employee_id ? `/admin/hr/overtime?employee_id=${context_employee_id}` : '/admin/hr/overtime';
            return res.redirect(redirectUrl);
        }
        
        validateEmployeeExists(db, employee_id, (empErr) => {
            if (empErr) {
                db.close();
                req.session.message = { type: 'error', text: empErr.message };
                const redirectUrl = context_employee_id ? `/admin/hr/overtime?employee_id=${context_employee_id}` : '/admin/hr/overtime';
                return res.redirect(redirectUrl);
            }
        
        const serverTotalAmount = parsedHours * parsedRate;
        
        db.run(`
            INSERT INTO overtime (employee_id, overtime_date, hours, rate, total_amount, reason, status)
            VALUES (?, ?, ?, ?, ?, ?, 'Pending')
        `, [employee_id, overtime_date, parsedHours, parsedRate, serverTotalAmount, reason], (err) => {
            if (err) {
                console.error('Error adding overtime:', err);
                req.session.message = { type: 'error', text: 'Error adding overtime' };
            } else {
                req.session.message = { type: 'success', text: 'Overtime added successfully!' };
            }
            
            db.close();
            const redirectUrl = context_employee_id ? `/admin/hr/overtime?employee_id=${context_employee_id}` : '/admin/hr/overtime';
            res.redirect(redirectUrl);
        });
        }); // close validateEmployeeExists
    }
}

// Process Overtime (Approve/Reject)
function hrProcessOvertime(req, res) {
    const db = getDbConnection();
    const overtimeId = req.params.id;
    const action = req.params.action;
    
    db.get('SELECT * FROM overtime WHERE id = ?', [overtimeId], (err, overtime) => {
        if (err) {
            db.close();
            return res.status(500).send('Database error');
        }
        
        if (!overtime) {
            db.close();
            return res.status(404).send('Overtime record not found');
        }
        
        const newStatus = action === 'approve' ? 'Approved' : 'Rejected';
        
        db.run(`
            UPDATE overtime SET
                status = ?,
                approved_by = ?,
                approved_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [newStatus, req.session.username, overtimeId], (err) => {
            if (err) {
                console.error('Error processing overtime:', err);
                req.session.message = { type: 'error', text: 'Error processing overtime' };
            } else {
                req.session.message = { type: 'success', text: `Overtime ${newStatus.toLowerCase()} successfully!` };
            }
            
            db.close();
            res.redirect('/admin/hr/overtime');
        });
    });
}

// Disciplinary Records
function hrDisciplinary(req, res) {
    const db = getDbConnection();
    const { employee_id } = req.query;
    
    let query = `
        SELECT dr.*, e.full_name, e.employee_id, e.photo_path
        FROM disciplinary_records dr 
        LEFT JOIN hr_employees e ON dr.employee_id = e.id 
    `;
    const params = [];
    
    if (employee_id) {
        query += ` WHERE dr.employee_id = ?`;
        params.push(employee_id);
    }
    
    query += ' ORDER BY dr.record_date DESC';
    
    db.all(query, params, (err, disciplinaryRecords) => {
        if (err) {
            db.close();
            return res.status(500).send('Database error');
        }
        
        let contextEmployee = null;
        if (employee_id) {
            db.get('SELECT * FROM hr_employees WHERE id = ?', [employee_id], (err, emp) => {
                if (err) {
                    db.close();
                    return res.status(500).send('Database error');
                }
                
                if (!emp) {
                    db.close();
                    return res.status(404).send('Employee not found');
                }
                
                contextEmployee = emp;
                
                db.all('SELECT id, full_name FROM hr_employees WHERE employment_status = "Active" ORDER BY full_name ASC', (err, employees) => {
                    if (err) {
                        db.close();
                        return res.status(500).send('Database error');
                    }
                    
                    db.close();
                    res.render('hr/disciplinary', {
                        disciplinaryRecords,
                        employees,
                        contextEmployee,
                        filters: { employee_id },
                        session: req.session
                    });
                });
            });
        } else {
            db.all('SELECT id, full_name FROM hr_employees WHERE employment_status = "Active" ORDER BY full_name ASC', (err, employees) => {
                db.close();
                if (err) {
                    return res.status(500).send('Database error');
                }
                
                res.render('hr/disciplinary', {
                    disciplinaryRecords,
                    employees,
                    contextEmployee,
                    filters: { employee_id },
                    session: req.session
                });
            });
        }
    });
}

// Add Disciplinary Record
function hrAddDisciplinary(req, res) {
    const db = getDbConnection();
    
    if (req.method === 'POST') {
        const { employee_id, record_date, type, description, action_taken, notes, context_employee_id } = req.body;
        
        validateEmployeeExists(db, employee_id, (empErr) => {
            if (empErr) {
                db.close();
                req.session.message = { type: 'error', text: empErr.message };
                const redirectUrl = context_employee_id ? `/admin/hr/disciplinary?employee_id=${context_employee_id}` : '/admin/hr/disciplinary';
                return res.redirect(redirectUrl);
            }
        
        db.run(`
            INSERT INTO disciplinary_records (employee_id, record_date, type, description, action_taken, issued_by, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [employee_id, record_date, type, description, action_taken, req.session.username, notes], (err) => {
            if (err) {
                console.error('Error adding disciplinary record:', err);
                req.session.message = { type: 'error', text: 'Error adding disciplinary record' };
            } else {
                req.session.message = { type: 'success', text: 'Disciplinary record added successfully!' };
            }
            
            db.close();
            const redirectUrl = context_employee_id ? `/admin/hr/disciplinary?employee_id=${context_employee_id}` : '/admin/hr/disciplinary';
            res.redirect(redirectUrl);
        });
        }); // close validateEmployeeExists
    }
}

// Performance Reviews
function hrPerformance(req, res) {
    const db = getDbConnection();
    const { employee_id } = req.query;
    
    let query = `
        SELECT pr.*, e.full_name, e.employee_id, e.photo_path
        FROM performance_reviews pr 
        LEFT JOIN hr_employees e ON pr.employee_id = e.id 
    `;
    const params = [];
    
    if (employee_id) {
        query += ` WHERE pr.employee_id = ?`;
        params.push(employee_id);
    }
    
    query += ' ORDER BY pr.review_date DESC';
    
    db.all(query, params, (err, performanceReviews) => {
        if (err) {
            db.close();
            return res.status(500).send('Database error');
        }
        
        let contextEmployee = null;
        if (employee_id) {
            db.get('SELECT * FROM hr_employees WHERE id = ?', [employee_id], (err, emp) => {
                if (err) {
                    db.close();
                    return res.status(500).send('Database error');
                }
                
                if (!emp) {
                    db.close();
                    return res.status(404).send('Employee not found');
                }
                
                contextEmployee = emp;
                
                db.all('SELECT id, full_name FROM hr_employees WHERE employment_status = "Active" ORDER BY full_name ASC', (err, employees) => {
                    if (err) {
                        db.close();
                        return res.status(500).send('Database error');
                    }
                    
                    db.close();
                    res.render('hr/performance', {
                        performanceReviews,
                        employees,
                        contextEmployee,
                        filters: { employee_id },
                        session: req.session
                    });
                });
            });
        } else {
            db.all('SELECT id, full_name FROM hr_employees WHERE employment_status = "Active" ORDER BY full_name ASC', (err, employees) => {
                db.close();
                if (err) {
                    return res.status(500).send('Database error');
                }
                
                res.render('hr/performance', {
                    performanceReviews,
                    employees,
                    contextEmployee,
                    filters: { employee_id },
                    session: req.session
                });
            });
        }
    });
}

// Add Performance Review
function hrAddPerformance(req, res) {
    const db = getDbConnection();
    
    if (req.method === 'POST') {
        const { employee_id, review_period, attendance_rating, work_quality_rating, discipline_rating, teamwork_rating, overall_rating, comments, reviewer_role, context_employee_id } = req.body;
        
        validateEmployeeExists(db, employee_id, (empErr) => {
            if (empErr) {
                db.close();
                req.session.message = { type: 'error', text: empErr.message };
                const redirectUrl = context_employee_id ? `/admin/hr/performance?employee_id=${context_employee_id}` : '/admin/hr/performance';
                return res.redirect(redirectUrl);
            }
        
        db.run(`
            INSERT INTO performance_reviews (employee_id, review_period, attendance_rating, work_quality_rating, discipline_rating, teamwork_rating, overall_rating, comments, reviewer_role, review_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `, [employee_id, review_period, attendance_rating, work_quality_rating, discipline_rating, teamwork_rating, overall_rating, comments, reviewer_role], (err) => {
            if (err) {
                console.error('Error adding performance review:', err);
                req.session.message = { type: 'error', text: 'Error adding performance review' };
            } else {
                req.session.message = { type: 'success', text: 'Performance review added successfully!' };
            }
            
            db.close();
            const redirectUrl = context_employee_id ? `/admin/hr/performance?employee_id=${context_employee_id}` : '/admin/hr/performance';
            res.redirect(redirectUrl);
        });
        }); // close validateEmployeeExists
    }
}

function hrMonthlyAttendanceSummary(req, res) {
    const db = getDbConnection();
    const today = getCurrentJalaliDate();
    const { month: rawMonth } = req.query;
    const dateParts = today.split('/');
    const currentYear = parseInt(dateParts[0], 10);
    const currentMonth = parseInt(dateParts[1], 10);

    let selectedYear, selectedMonth;
    if (rawMonth && /^\d{4}\/\d{2}$/.test(rawMonth)) {
        const mp = rawMonth.split('/');
        selectedYear = parseInt(mp[0], 10);
        selectedMonth = parseInt(mp[1], 10);
    } else {
        selectedYear = currentYear;
        selectedMonth = currentMonth;
    }

    const daysInMonth = getDaysInJalaliMonth(selectedYear, selectedMonth);
    const monthPrefix = `${selectedYear}/${String(selectedMonth).padStart(2, '0')}`;

    let empQuery = `
        SELECT e.id, e.employee_id, e.full_name, e.position, e.photo_path,
               d.name AS department_name
        FROM hr_employees e
        LEFT JOIN departments d ON e.department_id = d.id
        WHERE e.employment_status = 'Active'
        ORDER BY e.full_name ASC
    `;

    db.all(empQuery, [], (err, employees) => {
        if (err) {
            console.error('hrMonthlyAttendanceSummary error:', err);
            db.close();
            req.session.message = { type: 'error', text: 'Database error loading monthly attendance summary.' };
            return res.redirect('/admin/hr');
        }

        db.all(`
            SELECT a.employee_id, a.attendance_date, a.status,
                   a.late_minutes, a.early_departure_minutes
            FROM attendance a
            WHERE a.attendance_date LIKE ? ESCAPE '\\'
        `, [`${monthPrefix}%`], (attErr, attendanceRows) => {
            if (attErr) {
                console.error('hrMonthlyAttendanceSummary attendance query error:', attErr);
                db.close();
                req.session.message = { type: 'error', text: 'Database error loading attendance records.' };
                return res.redirect('/admin/hr');
            }

            const summaryMap = {};
            (employees || []).forEach(emp => {
                summaryMap[emp.id] = {
                    ...emp,
                    totalDays: 0,
                    present: 0,
                    absent: 0,
                    late: 0,
                    halfDay: 0,
                    holiday: 0,
                    leave: 0,
                    totalLateMinutes: 0,
                    totalEarlyDepartureMinutes: 0,
                    recordedDays: 0
                };
            });

            (attendanceRows || []).forEach(row => {
                if (!summaryMap[row.employee_id]) return;
                const s = summaryMap[row.employee_id];
                s.totalDays++;
                s.recordedDays++;
                switch (row.status) {
                    case 'Present':
                        s.present++;
                        break;
                    case 'Absent':
                        s.absent++;
                        break;
                    case 'Late':
                        s.late++;
                        break;
                    case 'Half Day':
                        s.halfDay++;
                        break;
                    case 'Holiday':
                        s.holiday++;
                        break;
                    case 'Leave':
                        s.leave++;
                        break;
                }
                if (row.late_minutes > 0) {
                    s.totalLateMinutes += row.late_minutes;
                }
                if (row.early_departure_minutes > 0) {
                    s.totalEarlyDepartureMinutes += row.early_departure_minutes;
                }
            });

            const summaryData = Object.values(summaryMap);

            const prevMonth = selectedMonth === 1 ? 12 : selectedMonth - 1;
            const prevYear = selectedMonth === 1 ? selectedYear - 1 : selectedYear;
            const nextMonth = selectedMonth === 12 ? 1 : selectedMonth + 1;
            const nextYear = selectedMonth === 12 ? selectedYear + 1 : selectedYear;
            const prevMonthStr = `${prevYear}/${String(prevMonth).padStart(2, '0')}`;
            const nextMonthStr = `${nextYear}/${String(nextMonth).padStart(2, '0')}`;

            db.close();
            res.render('hr/monthly-summary', {
                summaryData,
                selectedYear,
                selectedMonth,
                daysInMonth,
                prevMonth: prevMonthStr,
                nextMonth: nextMonthStr,
                today,
                session: req.session
            });
        });
    });
}

// Delete Employee
function hrDeleteEmployee(req, res) {
    const db = getDbConnection();
    const employeeId = req.params.id;

    // First get the employee to check for photo
    db.get('SELECT photo_path FROM hr_employees WHERE id = ?', [employeeId], (err, employee) => {
        if (err) {
            console.error('Error fetching employee for delete:', err);
            db.close();
            req.session.message = { type: 'error', text: 'Database error' };
            return res.redirect('/admin/hr/employees');
        }

        if (!employee) {
            db.close();
            req.session.message = { type: 'error', text: 'Employee not found' };
            return res.redirect('/admin/hr/employees');
        }

        const photoPath = employee.photo_path;

        // Delete the employee record
        db.run('DELETE FROM hr_employees WHERE id = ?', [employeeId], (deleteErr) => {
            if (deleteErr) {
                console.error('Error deleting employee:', deleteErr);
                db.close();
                req.session.message = { type: 'error', text: 'Error deleting employee' };
                return res.redirect('/admin/hr/employees');
            }

            // Delete photo file if it exists
            if (photoPath) {
                const filePath = path.join(__dirname, '..', 'public', photoPath);
                if (fs.existsSync(filePath)) {
                    try {
                        fs.unlinkSync(filePath);
                    } catch (e) {
                        console.error('Error deleting employee photo:', e);
                    }
                }
            }

            db.close();
            req.session.message = { type: 'success', text: 'Employee deleted successfully!' };
            res.redirect('/admin/hr/employees');
        });
    });
}

// Leave Type Management
function hrLeaveTypes(req, res) {
    const db = getDbConnection();
    db.all('SELECT * FROM leave_types ORDER BY id ASC', (err, leaveTypes) => {
        if (err) {
            db.close();
            return res.status(500).send('Database error');
        }
        db.close();
        res.render('hr/leave-types', {
            leaveTypes,
            session: req.session
        });
    });
}

function hrEditLeaveType(req, res) {
    const db = getDbConnection();
    const { id } = req.params;
    db.get('SELECT * FROM leave_types WHERE id = ?', [id], (err, leaveType) => {
        if (err) {
            db.close();
            return res.status(500).send('Database error');
        }
        if (!leaveType) {
            db.close();
            return res.status(404).send('Leave type not found');
        }
        db.close();
        res.render('hr/leave-type-edit', {
            leaveType,
            session: req.session
        });
    });
}

function hrUpdateLeaveType(req, res) {
    const db = getDbConnection();
    const { id } = req.params;
    const { name, description, default_days, active } = req.body;

    if (!name || !name.trim()) {
        db.close();
        req.session.message = { type: 'error', text: 'Leave type name is required.' };
        return res.redirect('/admin/hr/leave-types/' + id + '/edit');
    }

    const days = parseInt(default_days, 10);
    if (isNaN(days) || days < 0) {
        db.close();
        req.session.message = { type: 'error', text: 'Default allowance must be a non-negative integer.' };
        return res.redirect('/admin/hr/leave-types/' + id + '/edit');
    }

    db.get('SELECT id FROM leave_types WHERE name = ? AND id != ?', [name.trim(), id], (err, existing) => {
        if (err) {
            db.close();
            return res.status(500).send('Database error');
        }
        if (existing) {
            db.close();
            req.session.message = { type: 'error', text: 'A leave type with this name already exists.' };
            return res.redirect('/admin/hr/leave-types/' + id + '/edit');
        }

        const isActive = active === 'on' || active === '1' || active === true ? 1 : 0;

        db.run(
            'UPDATE leave_types SET name = ?, description = ?, default_days = ?, active = ? WHERE id = ?',
            [name.trim(), description || '', days, isActive, id],
            function(err) {
                if (err) {
                    db.close();
                    return res.status(500).send('Database error');
                }
                db.close();
                req.session.message = { type: 'success', text: 'Leave type updated successfully.' };
                res.redirect('/admin/hr/leave-types');
            }
        );
    });
}

function hrToggleLeaveType(req, res) {
    const db = getDbConnection();
    const { id } = req.params;
    db.get('SELECT * FROM leave_types WHERE id = ?', [id], (err, leaveType) => {
        if (err) {
            db.close();
            return res.status(500).send('Database error');
        }
        if (!leaveType) {
            db.close();
            return res.status(404).send('Leave type not found');
        }
        const newActive = leaveType.active ? 0 : 1;
        db.run('UPDATE leave_types SET active = ? WHERE id = ?', [newActive, id], function(err) {
            if (err) {
                db.close();
                return res.status(500).send('Database error');
            }
            db.close();
            req.session.message = {
                type: 'success',
                text: newActive ? 'Leave type activated successfully.' : 'Leave type deactivated successfully.'
            };
            res.redirect('/admin/hr/leave-types');
        });
    });
}

// Generate Employee Employment Contract PDF
function hrGenerateContract(req, res) {
    const db = getDbConnection();
    const { id } = req.params;
    const lang = req.query.lang || 'en';

    if (!['en', 'da', 'ps'].includes(lang)) {
        db.close();
        return res.status(400).send('Unsupported language. Use en, da, or ps.');
    }

    const PDFDocument = require('pdfkit');
    const todayJalali = getCurrentJalaliDate();
    const isRTL = (lang === 'da' || lang === 'ps');

    // C4.6: Register fonts for RTL languages
    const fontRegular = isRTL ? 'C:/Windows/Fonts/tahoma.ttf' : 'Helvetica';
    const fontBold = isRTL ? 'C:/Windows/Fonts/tahomabd.ttf' : 'Helvetica-Bold';

    db.get(`
        SELECT e.*, d.name as department_name
        FROM hr_employees e
        LEFT JOIN departments d ON e.department_id = d.id
        WHERE e.id = ?
    `, [id], (err, employee) => {
        if (err) {
            db.close();
            console.error('Contract DB error:', err);
            return res.status(500).send('Database error');
        }
        if (!employee) {
            db.close();
            return res.status(400).send('Employee not found');
        }

        const currentJalali = getCurrentJalaliDate();
        const salaryQuery = `
            SELECT * FROM employee_salary_history
            WHERE employee_id = ? AND (effective_to IS NULL OR effective_to >= ?)
            ORDER BY effective_from DESC LIMIT 1
        `;
        db.get(salaryQuery, [id, currentJalali], (salErr, salaryRecord) => {
            const scheduleQuery = employee.work_schedule_id
                ? 'SELECT * FROM work_schedules WHERE id = ?'
                : 'SELECT NULL as id';
            const scheduleParam = employee.work_schedule_id || null;

            db.get(scheduleQuery, [scheduleParam], (schedErr, schedule) => {
                db.close();

                const doc = new PDFDocument({ size: 'A4', margin: 60 });
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('Content-Disposition', `attachment; filename="contract_${employee.employee_id || id}.pdf"`);
                doc.pipe(res);

                const pageW = doc.page.width - 120;

                // RTL helpers
                function rtlX(width) { return isRTL ? (60 + pageW - width) : 60; }
                function rtlAlign() { return isRTL ? 'right' : 'left'; }
                function rtlLabelX() { return isRTL ? (60 + pageW - 190 - 60) : 70; }
                function rtlValueX() { return isRTL ? 60 : 260; }

                function tr(key) { return i18n(lang, 'hr.contract.' + key) || key; }

                // --- PAGE 1: Header + Employee Info ---
                const logoPath = path.join(__dirname, '..', 'public', 'Logo.png');
                if (fs.existsSync(logoPath)) {
                    doc.image(logoPath, (pageW - 80) / 2 + 60, 50, { width: 80, height: 80 });
                }
                doc.moveDown(5.5);

                doc.registerFont('ContractFont', fontRegular);
                doc.registerFont('ContractFontBold', fontBold);

                doc.font('ContractFontBold').fontSize(16).text(tr('company_name'), 60, 140, { align: 'center', width: pageW });
                doc.moveDown(0.3);

                doc.font('ContractFontBold').fontSize(20).text(tr('title'), 60, doc.y, { align: 'center', width: pageW });
                doc.moveDown(0.3);

                doc.moveTo(60, doc.y).lineTo(60 + pageW, doc.y).stroke();
                doc.moveDown(0.8);

                // Section: Employee Information
                let rowY = doc.y;
                doc.font('ContractFontBold').fontSize(13).text(tr('section_employee_info'), rtlX(pageW), rowY, { align: rtlAlign(), width: pageW });
                doc.moveDown(0.5);
                rowY = doc.y;

                function addInfoRow(label, value) {
                    const lx = rtlLabelX();
                    const vx = rtlValueX();
                    doc.font('ContractFont').fontSize(10);
                    doc.text(label + ':', lx, rowY, { width: 190, align: rtlAlign() });
                    doc.text(value || '', vx, rowY, { width: 300, align: rtlAlign() });
                    rowY = doc.y + 6;
                }

                addInfoRow(tr('full_name'), employee.full_name);
                if (employee.father_name) {
                    addInfoRow(tr('father_name'), employee.father_name);
                }
                addInfoRow(tr('date_of_birth'), employee.date_of_birth || tr('not_specified'));
                addInfoRow(tr('employee_id'), employee.employee_id || 'N/A');
                addInfoRow(tr('address'), employee.address || tr('not_specified'));
                addInfoRow(tr('phone'), employee.phone || 'N/A');

                rowY += 10;

                // Section: Contract Details
                doc.font('ContractFontBold').fontSize(13).text(tr('section_contract_details'), rtlX(pageW), rowY, { align: rtlAlign(), width: pageW });
                doc.moveDown(0.5);
                rowY = doc.y;

                const contractType = employee.contract_type || tr('employment');
                addInfoRow(tr('contract_type'), contractType);
                addInfoRow(tr('start_date'), employee.hire_date || tr('not_specified'));

                const isPermanent = !contractType ||
                    contractType.toLowerCase() === 'permanent' ||
                    contractType.toLowerCase() === 'permanent contract';

                if (!isPermanent) {
                    addInfoRow(tr('end_date'), employee.employment_end_date || tr('not_specified'));
                }

                addInfoRow(tr('department'), employee.department_name || tr('not_assigned'));
                addInfoRow(tr('position'), employee.position || tr('not_specified'));

                rowY += 10;

                // Section: Salary & Benefits
                doc.font('ContractFontBold').fontSize(13).text(tr('section_salary'), rtlX(pageW), rowY, { align: rtlAlign(), width: pageW });
                doc.moveDown(0.5);
                rowY = doc.y;

                if (salaryRecord) {
                    const basic = salaryRecord.basic_salary || 0;
                    const allowances = salaryRecord.allowances || 0;
                    const total = basic + allowances;
                    addInfoRow(tr('basic_salary'), basic.toLocaleString() + ' ' + tr('currency'));
                    addInfoRow(tr('allowances'), allowances.toLocaleString() + ' ' + tr('currency'));
                    addInfoRow(tr('total_monthly_salary'), total.toLocaleString() + ' ' + tr('currency'));
                } else {
                    addInfoRow(tr('basic_salary'), tr('not_specified'));
                }

                addInfoRow(tr('payment_method'), employee.payment_method || tr('not_specified'));
                addInfoRow(tr('work_location'), employee.work_location || tr('not_specified'));

                // Section: Working Hours & Schedule
                if (schedule && schedule.id) {
                    rowY += 10;
                    doc.font('ContractFontBold').fontSize(13).text(tr('section_schedule'), rtlX(pageW), rowY, { align: rtlAlign(), width: pageW });
                    doc.moveDown(0.5);
                    rowY = doc.y;

                    addInfoRow(tr('schedule_name'), schedule.name || 'N/A');
                    addInfoRow(tr('expected_check_in'), schedule.expected_check_in || 'N/A');
                    addInfoRow(tr('expected_check_out'), schedule.expected_check_out || 'N/A');

                    const dayMap = { '1': tr('day_saturday'), '2': tr('day_sunday'), '3': tr('day_monday'), '4': tr('day_tuesday'), '5': tr('day_wednesday'), '6': tr('day_thursday'), '7': tr('day_friday') };
                    const workDays = (schedule.working_days || '1,2,3,4,5').split(',').map(d => dayMap[d.trim()] || d.trim()).join(', ');
                    addInfoRow(tr('working_days'), workDays);
                }

                // --- PAGE 2: Terms & Conditions ---
                doc.addPage();
                rowY = 60;

                doc.font('ContractFontBold').fontSize(13).text(tr('section_terms'), rtlX(pageW), rowY, { align: rtlAlign(), width: pageW });
                doc.moveDown(0.5);
                rowY = doc.y;

                doc.font('ContractFont').fontSize(10);
                const terms = i18n(lang, 'hr.contract.terms') || [];
                terms.forEach((term, i) => {
                    const bullet = `${i + 1}. ${term}`;
                    doc.text(bullet, rtlX(pageW - 20), rowY, { width: pageW - 20, align: rtlAlign() });
                    rowY = doc.y + 6;
                });

                rowY += 10;

                // Section: Acknowledgement
                doc.font('ContractFontBold').fontSize(13).text(tr('section_acknowledgement'), rtlX(pageW), rowY, { align: rtlAlign(), width: pageW });
                doc.moveDown(0.5);
                rowY = doc.y;

                doc.font('ContractFont').fontSize(10);
                const acknowledgement = i18n(lang, 'hr.contract.acknowledgement') || '';
                doc.text(acknowledgement, rtlX(pageW - 20), rowY, { width: pageW - 20, align: rtlAlign() });

                rowY = doc.y + 40;

                // Signature section
                doc.moveTo(60, rowY).lineTo(60 + pageW, rowY).stroke();
                rowY += 15;

                doc.font('ContractFontBold').fontSize(11).text(tr('signatures'), 60, rowY, { align: 'center', width: pageW });
                rowY = doc.y + 25;

                doc.font('ContractFont').fontSize(10);
                if (isRTL) {
                    doc.text(tr('hr_representative'), 350, rowY, { width: 180, align: 'right' });
                    doc.text(tr('employee_label'), 70, rowY, { width: 180, align: 'right' });
                } else {
                    doc.text(tr('employee_label'), 70, rowY);
                    doc.text(tr('hr_representative'), 350, rowY);
                }
                rowY += 35;

                doc.moveTo(70, rowY).lineTo(250, rowY).stroke();
                doc.moveTo(350, rowY).lineTo(530, rowY).stroke();
                rowY += 12;

                doc.font('ContractFont').fontSize(9);
                if (isRTL) {
                    doc.text(tr('hr_name'), 350, rowY, { width: 180, align: 'center' });
                    doc.text(employee.full_name || 'Employee', 70, rowY, { width: 180, align: 'center' });
                } else {
                    doc.text(employee.full_name || 'Employee', 70, rowY, { width: 180, align: 'center' });
                    doc.text(tr('hr_name'), 350, rowY, { width: 180, align: 'center' });
                }
                rowY += 15;

                doc.text(tr('date_line'), 70, rowY, { width: 180, align: 'center' });
                doc.text(tr('date_line'), 350, rowY, { width: 180, align: 'center' });

                rowY += 40;

                // Footer
                doc.moveTo(60, rowY).lineTo(60 + pageW, rowY).stroke();
                rowY += 10;
                doc.font('ContractFont').fontSize(8).text(tr('footer_generated').replace('{date}', todayJalali), 60, rowY, { align: 'center', width: pageW });

                doc.end();
            });
        });
    });
}

// =====================================================
// C4.1 Employee Document Infrastructure
// =====================================================

const DOCUMENT_STORAGE_DIR = path.join(__dirname, '..', 'storage', 'employee-documents');

// Category mapping for UI categories
const DOCUMENT_CATEGORY_MAP = {
    'tazkira_passport': [4, 8],       // Tazkira + Passport
    'cv': [7],                         // CV
    'degrees_certificates': [2, 5],   // Training Certificate + Certificate
    'other': [3]                       // Other
};

// Field-to-category mapping for Add Employee form
const DOCUMENT_FIELD_MAP = {
    'document_tazkira_passport': 4,       // Tazkira (default for this category)
    'document_cv': 7,                     // CV
    'document_degrees_certificates': 2,   // Training Certificate (default for this category)
    'document_other': 3                   // Other
};

// Process document uploads after employee creation (C4.2)
function processDocumentUploads(db, employeeId, req, res, employeeName, callback) {
    const fileFields = ['document_tazkira_passport', 'document_cv', 'document_degrees_certificates', 'document_other'];
    const uploadedFiles = [];

    fileFields.forEach(function(fieldName) {
        if (req.files && req.files[fieldName] && req.files[fieldName].length > 0) {
            uploadedFiles.push({ fieldName: fieldName, file: req.files[fieldName][0] });
        }
    });

    if (uploadedFiles.length === 0) {
        return callback(null);
    }

    var validationPromises = uploadedFiles.map(function(item) {
        return validatePdfMagicBytes(item.file.path)
            .then(function() { return { valid: true, item: item }; })
            .catch(function(err) { return { valid: false, item: item, error: err }; });
    });

    Promise.all(validationPromises).then(function(results) {
        var failures = results.filter(function(r) { return !r.valid; });
        if (failures.length > 0) {
            var storedFiles = uploadedFiles.map(function(item) { return item.file.path; });
                        return callback({ message: 'Invalid PDF file(s): ' + failures.length + ' file(s) failed validation', storedFiles: storedFiles });
        }

        var pending = uploadedFiles.length;
        var insertError = false;

        uploadedFiles.forEach(function(item) {
            var docTypeId = DOCUMENT_FIELD_MAP[item.fieldName];
            var filePath = item.file.path;
            var originalFilename = item.file.originalname;
            var projectRoot = path.join(__dirname, '..');
            var relativePath = path.relative(projectRoot, filePath).replace(/\\/g, '/');

            db.run(`
                INSERT INTO employee_documents (employee_id, document_type_id, file_path, original_filename, uploaded_by)
                VALUES (?, ?, ?, ?, ?)
            `, [employeeId, docTypeId, relativePath, originalFilename, req.session.username || null], function(insertErr) {
                if (insertErr) {
                    console.error('Error inserting document record:', insertErr);
                    insertError = true;
                }
                pending--;
                if (pending === 0) {
                    if (insertError) {
                        callback({ message: 'Error saving document records.', storedFiles: uploadedFiles.map(function(i) { return i.file.path; }) });
                    } else {
                        callback(null);
                    }
                }
            });
        });
    });
}

// Upload a new employee document (PDF)
function hrUploadDocument(req, res) {
    const db = getDbConnection();
    const { employee_id, document_type_id, document_number, issue_date, expiry_date, notes } = req.body;

    if (!employee_id || !document_type_id) {
        if (req.file) fs.unlink(req.file.path, () => {});
        db.close();
        req.session.message = { type: 'error', text: 'Employee ID and document type are required.' };
        return redirectBack(req, res, req.params.employeeId ? '/admin/hr/employees/' + req.params.employeeId : '/admin/hr/employees');
    }

    // CORRECTION 2: Require a PDF file for new uploads
    if (!req.file) {
        db.close();
        req.session.message = { type: 'error', text: 'A PDF file is required.' };
        return redirectBack(req, res, req.params.employeeId ? '/admin/hr/employees/' + req.params.employeeId : '/admin/hr/employees');
    }

    validateEmployeeExists(db, employee_id, (empErr) => {
        if (empErr) {
            if (req.file) fs.unlink(req.file.path, () => {});
            db.close();
            req.session.message = { type: 'error', text: empErr.message };
            return redirectBack(req, res, req.params.employeeId ? '/admin/hr/employees/' + req.params.employeeId : '/admin/hr/employees');
        }

        // Validate document type exists
        db.get('SELECT id FROM document_types WHERE id = ? AND active = 1', [document_type_id], (dtErr, docType) => {
            if (dtErr || !docType) {
                if (req.file) fs.unlink(req.file.path, () => {});
                db.close();
                req.session.message = { type: 'error', text: 'Invalid document type.' };
                return redirectBack(req, res, req.params.employeeId ? '/admin/hr/employees/' + req.params.employeeId : '/admin/hr/employees');
            }

            // Validate PDF magic bytes
            validatePdfMagicBytes(req.file.path)
                .then(() => {
                    insertDocumentRecord(db, employee_id, document_type_id, document_number, issue_date, expiry_date, notes, req.file.path, req.file.originalname, req, res);
                })
                .catch((pdfErr) => {
                    fs.unlink(req.file.path, () => {});
                    db.close();
                    req.session.message = { type: 'error', text: pdfErr && pdfErr.safe ? 'Invalid PDF file: ' + pdfErr.message : 'Invalid PDF file' };
                    return redirectBack(req, res, req.params.employeeId ? '/admin/hr/employees/' + req.params.employeeId : '/admin/hr/employees');
                });
        });
    });
}

function insertDocumentRecord(db, employee_id, document_type_id, document_number, issue_date, expiry_date, notes, filePath, originalFilename, req, res) {
    // Store relative path from project root (storage/ is private, outside public/)
    const projectRoot = path.join(__dirname, '..');
    const relativePath = filePath ? path.relative(projectRoot, filePath).replace(/\\/g, '/') : null;

    db.run(`
        INSERT INTO employee_documents (employee_id, document_type_id, document_number, issue_date, expiry_date, file_path, original_filename, notes, uploaded_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [employee_id, document_type_id, document_number || null, issue_date || null, expiry_date || null, relativePath, originalFilename, notes || null, req.session.username || null], function(err) {
        if (err) {
            console.error('Error uploading document:', err);
            if (filePath) fs.unlink(filePath, () => {});
            db.close();
            req.session.message = { type: 'error', text: 'Error saving document' };
            return redirectBack(req, res, req.params.employeeId ? '/admin/hr/employees/' + req.params.employeeId : '/admin/hr/employees');
        }
        db.close();
        req.session.message = { type: 'success', text: 'Document uploaded successfully!' };
        redirectBack(req, res, req.params.employeeId ? '/admin/hr/employees/' + req.params.employeeId : '/admin/hr/employees');
    });
}

// Replace an existing employee document file
function hrReplaceDocument(req, res) {
    const db = getDbConnection();
    const { employeeId, documentId } = req.params;

    if (!employeeId || !documentId) {
        if (req.file) fs.unlink(req.file.path, () => {});
        db.close();
        req.session.message = { type: 'error', text: 'Employee ID and document ID are required.' };
        return redirectBack(req, res, req.params.employeeId ? '/admin/hr/employees/' + req.params.employeeId : '/admin/hr/employees');
    }

    // Verify document belongs to this employee
    db.get('SELECT * FROM employee_documents WHERE id = ? AND employee_id = ?', [documentId, employeeId], (err, doc) => {
        if (err || !doc) {
            if (req.file) fs.unlink(req.file.path, () => {});
            db.close();
            req.session.message = { type: 'error', text: 'Document not found.' };
            return redirectBack(req, res, req.params.employeeId ? '/admin/hr/employees/' + req.params.employeeId : '/admin/hr/employees');
        }

        if (!req.file) {
            db.close();
            req.session.message = { type: 'error', text: 'No file provided for replacement.' };
            return redirectBack(req, res, req.params.employeeId ? '/admin/hr/employees/' + req.params.employeeId : '/admin/hr/employees');
        }

            // Validate PDF magic bytes
            validatePdfMagicBytes(req.file.path)
                .then(() => {
                    const projectRoot = path.join(__dirname, '..');
                    const newRelativePath = path.relative(projectRoot, req.file.path).replace(/\\/g, '/');
                    const oldFilePath = doc.file_path ? path.join(projectRoot, doc.file_path) : null;

                // Update database first
                db.run(`
                    UPDATE employee_documents
                    SET file_path = ?, original_filename = ?, uploaded_by = ?, created_at = CURRENT_TIMESTAMP
                    WHERE id = ? AND employee_id = ?
                `, [newRelativePath, req.file.originalname, req.session.username || null, documentId, employeeId], function(updateErr) {
                    if (updateErr) {
                        fs.unlink(req.file.path, () => {});
                        db.close();
                        req.session.message = { type: 'error', text: 'Error updating document' };
                        return redirectBack(req, res, req.params.employeeId ? '/admin/hr/employees/' + req.params.employeeId : '/admin/hr/employees');
                    }

                    // Only remove old file after successful DB update
                    if (oldFilePath && fs.existsSync(oldFilePath) && oldFilePath !== req.file.path) {
                        fs.unlink(oldFilePath, (unlinkErr) => {
                            if (unlinkErr) console.error('Warning: Could not remove old document file:', unlinkErr.message);
                        });
                    }

                    db.close();
                    req.session.message = { type: 'success', text: 'Document replaced successfully!' };
                    redirectBack(req, res, req.params.employeeId ? '/admin/hr/employees/' + req.params.employeeId : '/admin/hr/employees');
                });
            })
            .catch((pdfErr) => {
                fs.unlink(req.file.path, () => {});
                db.close();
                req.session.message = { type: 'error', text: pdfErr && pdfErr.safe ? 'Invalid PDF file: ' + pdfErr.message : 'Invalid PDF file' };
                return redirectBack(req, res, req.params.employeeId ? '/admin/hr/employees/' + req.params.employeeId : '/admin/hr/employees');
            });
    });
}

// Remove an employee document (record + file)
function hrRemoveDocument(req, res) {
    const db = getDbConnection();
    const { employeeId, documentId } = req.params;

    if (!employeeId || !documentId) {
        db.close();
        req.session.message = { type: 'error', text: 'Employee ID and document ID are required.' };
        return redirectBack(req, res, req.params.employeeId ? '/admin/hr/employees/' + req.params.employeeId : '/admin/hr/employees');
    }

    // Verify document belongs to this employee
    db.get('SELECT * FROM employee_documents WHERE id = ? AND employee_id = ?', [documentId, employeeId], (err, doc) => {
        if (err || !doc) {
            db.close();
            req.session.message = { type: 'error', text: 'Document not found.' };
            return redirectBack(req, res, req.params.employeeId ? '/admin/hr/employees/' + req.params.employeeId : '/admin/hr/employees');
        }

        // Delete database record first
        db.run('DELETE FROM employee_documents WHERE id = ? AND employee_id = ?', [documentId, employeeId], function(delErr) {
            if (delErr) {
                db.close();
                req.session.message = { type: 'error', text: 'Error removing document' };
                return redirectBack(req, res, req.params.employeeId ? '/admin/hr/employees/' + req.params.employeeId : '/admin/hr/employees');
            }

            // Remove file after successful DB deletion
            if (doc.file_path) {
                const projectRoot = path.join(__dirname, '..');
                const fullPath = path.join(projectRoot, doc.file_path);
                if (fs.existsSync(fullPath)) {
                    fs.unlink(fullPath, (unlinkErr) => {
                        if (unlinkErr) console.error('Warning: Could not remove document file:', unlinkErr.message);
                    });
                }
            }

            db.close();
            req.session.message = { type: 'success', text: 'Document removed successfully!' };
            redirectBack(req, res, req.params.employeeId ? '/admin/hr/employees/' + req.params.employeeId : '/admin/hr/employees');
        });
    });
}

// Secure view/download of employee document PDF
function hrViewDocument(req, res) {
    const db = getDbConnection();
    const { employeeId, documentId } = req.params;

    if (!employeeId || !documentId) {
        db.close();
        return res.status(400).send('Invalid request.');
    }

    db.get('SELECT * FROM employee_documents WHERE id = ? AND employee_id = ?', [documentId, employeeId], (err, doc) => {
        if (err || !doc) {
            db.close();
            return res.status(404).send('Document not found.');
        }

        if (!doc.file_path) {
            db.close();
            return res.status(404).send('No file associated with this document.');
        }

        // Resolve and validate path
        const projectRoot = path.join(__dirname, '..');
        const resolvedPath = path.resolve(projectRoot, doc.file_path);

        // Prevent path traversal — resolved path must stay inside project root
        if (!resolvedPath.startsWith(path.resolve(projectRoot))) {
            db.close();
            return res.status(403).send('Access denied.');
        }

        // Check file exists
        if (!fs.existsSync(resolvedPath)) {
            db.close();
            return res.status(404).send('Document file not found on server.');
        }

        db.close();

        // Serve PDF inline for browser viewing
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename="' + (doc.original_filename || 'document.pdf').replace(/[^a-zA-Z0-9._-]/g, '_') + '"');
        res.setHeader('X-Content-Type-Options', 'nosniff');

        const fileStream = fs.createReadStream(resolvedPath);
        fileStream.on('error', () => {
            res.status(500).send('Error reading document file.');
        });
        fileStream.pipe(res);
    });
}

module.exports = {
    hrDashboard,
    hrEmployees,
    hrAddEmployee,
    hrEditEmployee,
    hrEmployeeProfile,
    hrDepartments,
    hrDeleteDepartment,
    hrSalaryHistory,
    hrPayroll,
    hrGeneratePayroll,
    hrPreviewPayroll,
    hrCreateSelectedPayroll,
    hrPayrollDetail,
    hrMarkPayrollPaid,
    hrAdvances,
    hrAddAdvance,
    hrAdvanceRepayment,
    hrDeductions,
    hrAddDeduction,
    hrLeaveRequests,
    hrAddLeaveRequest,
    hrProcessLeaveRequest,
    hrLeaveBalances,
    hrLeaveTypes,
    hrEditLeaveType,
    hrUpdateLeaveType,
    hrToggleLeaveType,
    hrDocuments,
    hrAddDocument,
    hrAttendance,
    hrAddAttendance,
    hrBulkAttendance,
    hrEditAttendance,
    hrUpdateAttendance,
    hrWorkSchedules,
    hrAddWorkSchedule,
    hrDeleteWorkSchedule,
    hrEditWorkSchedule,
    hrMarkAllPresent,
    hrBulkStatusApply,
    hrOvertime,
    hrAddOvertime,
    hrProcessOvertime,
    hrDisciplinary,
    hrAddDisciplinary,
    hrPerformance,
    hrAddPerformance,
    hrGenerateContract,
    calculateEmployeePayroll,
    getEmployeeArrears,
    validateSelectedArrears,
    hrMonthlyAttendanceSummary,
    hrDeleteEmployee,
    hrUploadDocument,
    hrReplaceDocument,
    hrRemoveDocument,
    hrViewDocument,
    DOCUMENT_CATEGORY_MAP
};