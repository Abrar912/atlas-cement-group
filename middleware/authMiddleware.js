function requireLogin(req, res, next) {
    if (req.session && req.session.user_id) {
        return next();
    }
    return res.redirect('/login');
}

function requireRole(role) {
    return function(req, res, next) {
        if (req.session && req.session.role === role) {
            return next();
        }
        return res.redirect('/login');
    };
}

function requireAdmin(req, res, next) {
    console.log('[AUTH DEBUG] requireAdmin called');
    console.log('[AUTH DEBUG] Path:', req.path);
    console.log('[AUTH DEBUG] Session exists:', !!req.session);
    console.log('[AUTH DEBUG] Session role:', req.session?.role);
    console.log('[AUTH DEBUG] Session username:', req.session?.username);
    console.log('[AUTH DEBUG] Session user_id:', req.session?.user_id);
    
    if (req.session && req.session.role === 'admin') {
        console.log('[AUTH DEBUG] requireAdmin PASSED - calling next()');
        return next();
    }
    
    console.log('[AUTH DEBUG] requireAdmin DENIED - returning 403');
    return res.status(403).render('403', {
        title: 'دسترسی ممنوع',
        message: 'فقط مدیران سیستم به این بخش دسترسی دارند.'
    });
}

function requireAnyRole(roles) {
    return function(req, res, next) {
        if (req.session && roles.includes(req.session.role)) {
            return next();
        }
        return res.redirect('/login');
    };
}

function requirePermission(permission) {
    return function(req, res, next) {
        // Admins always have access to everything
        if (req.session && req.session.role === 'admin') {
            return next();
        }
        
        // Check if user has the specific permission
        if (req.session && req.session.permissions) {
            let userPermissions = [];
            try {
                userPermissions = JSON.parse(req.session.permissions);
            } catch (e) {
                userPermissions = [];
            }
            
            if (userPermissions.includes(permission)) {
                return next();
            }
        }
        
        // If no permission, render 403 page
        return res.status(403).render('403', { 
            title: 'دسترسی ممنوع',
            message: 'شما صلاحیت دسترسی به این صفحه را ندارید.' 
        });
    };
}

function checkPagePermission(req, res, next) {
    console.log('[AUTH DEBUG] checkPagePermission called');
    console.log('[AUTH DEBUG] Path:', req.path);
    console.log('[AUTH DEBUG] Session role:', req.session?.role);
    console.log('[AUTH DEBUG] Session username:', req.session?.username);

    // Phase 27B: authentication gate — unauthenticated requests cannot pass.
    if (!req.session || !req.session.user_id) {
        console.log('[AUTH DEBUG] checkPagePermission DENIED - unauthenticated');
        if (req.path.startsWith('/api/')) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        return res.status(403).render('403', {
            title: 'دسترسی ممنوع',
            message: 'برای دسترسی به این بخش ابتدا وارد حساب کاربری خود شوید.'
        });
    }

    // Admins always have access to everything
    if (req.session && req.session.role === 'admin') {
        return next();
    }
    
    // Get the current route path
    const routePath = req.path;
    
    // Map route paths to permission keys
    const routePermissionMap = {
        '/admin': 'dashboard',
        '/admin/all-agency-expenses': 'agency-expenses',
        '/agent-remittances': 'dashboard',
        '/admin/local-waybill': 'waybill-entry',
        '/admin/manage-users': 'manage-users',
        '/admin/homepage-control': 'homepage-control',
        '/waybills/new': 'waybill-entry',
        '/worker': 'waybill-entry',
        '/worker/command-deck': 'waybill-entry',
        '/worker/agent-remittances': 'waybill-log',
        '/worker/daily-expenses': 'freight-expenses',
        '/worker/money-receipts': 'customer-ledgers',
        '/worker/manage-customers': 'customer-ledgers',
        '/api/config/cement-types': 'waybill-entry'
    };
    
    // Get the required permission for this route
    const requiredPermission = routePermissionMap[routePath];
    
    // Phase 27B: default-deny — unmapped protected paths fail closed.
    if (!requiredPermission) {
        console.log('[AUTH DEBUG] checkPagePermission DEFAULT DENY - unmapped path');
        if (routePath.startsWith('/api/')) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        return res.status(403).render('403', {
            title: 'دسترسی ممنوع',
            message: 'شما صلاحیت دسترسی به این صفحه را ندارید.'
        });
    }
    
    // Check if user has the required permission
    if (req.session && req.session.permissions) {
        let userPermissions = [];
        try {
            userPermissions = JSON.parse(req.session.permissions);
        } catch (e) {
            userPermissions = [];
        }
        
        console.log('[AUTH DEBUG] Required permission:', requiredPermission);
        console.log('[AUTH DEBUG] User permissions:', userPermissions);
        
        if (userPermissions.includes(requiredPermission)) {
            return next();
        }
    }
    
    // If no permission, render 403 page
    console.log('[AUTH DEBUG] checkPagePermission DENIED - returning 403');
    return res.status(403).render('403', { 
        title: 'دسترسی ممنوع',
        message: 'شما صلاحیت دسترسی به این صفحه را ندارید.' 
    });
}

function requireUpdatePermission(req, res, next) {
    // Admins always have update permission
    if (req.session && req.session.role === 'admin') {
        return next();
    }
    
    // Check if user has can_update permission
    if (req.session && req.session.can_update === 1) {
        return next();
    }
    
    // If no update permission, return error
    return res.status(403).json({ 
        error: 'حساب شما صلاحیت ویرایش اطلاعات را ندارد.' 
    });
}

function requireDeletePermission(req, res, next) {
    // Admins always have delete permission
    if (req.session && req.session.role === 'admin') {
        return next();
    }
    
    // Check if user has can_delete permission
    if (req.session && req.session.can_delete === 1) {
        return next();
    }
    
    // If no delete permission, return error
    return res.status(403).json({ 
        error: 'حساب شما صلاحیت حذف اطلاعات را ندارد.' 
    });
}

module.exports = { requireLogin, requireRole, requireAdmin, requireAnyRole, requirePermission, checkPagePermission, requireUpdatePermission, requireDeletePermission };
