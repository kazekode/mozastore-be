import { Order, Product, Category, ProductStock, Bot } from './index.js';

export async function getAdminStats(botId) {
    try {
        const productsCount = await Product.countDocuments({ botId });

        const agg = await Order.aggregate([
            { $match: { botId } },
            { $unwind: { path: "$items", preserveNullAndEmptyArrays: true } },
            { 
                $group: {
                    _id: { source: "$source", status: "$status", orderId: "$orderId" },
                    revenue: { $first: "$totalAmount" },
                    items: { $sum: "$items.quantity" }
                }
            },
            {
                $group: {
                    _id: { source: "$_id.source", status: "$_id.status" },
                    count: { $sum: 1 },
                    revenue: { $sum: "$revenue" },
                    items_sold: { $sum: "$items" }
                }
            }
        ]);

        let telegram = { orders: 0, pending: 0, completed: 0, revenue: 0, items_sold: 0 };
        let website = { orders: 0, pending: 0, completed: 0, revenue: 0, items_sold: 0 };

        for (const group of agg) {
            const isWeb = (group._id.source === 'web' || group._id.source === 'website');
            const target = isWeb ? website : telegram;
            
            target.orders += group.count;
            if (group._id.status === 'completed' || group._id.status === 'paid') {
                target.completed += group.count;
                target.revenue += group.revenue;
                target.items_sold += group.items_sold;
            } else if (group._id.status === 'pending') {
                target.pending += group.count;
            }
        }

        return {
            success: true,
            data: {
                products: productsCount,
                website,
                telegram,
                total: {
                    orders: website.orders + telegram.orders,
                    revenue: website.revenue + telegram.revenue,
                    pending: website.pending + telegram.pending,
                    completed: website.completed + telegram.completed,
                    items_sold: website.items_sold + telegram.items_sold
                },
                // Add legacy compatibility keys for Webdash and Telegram
                totalUsers: 0, // Should fetch real users if needed
                totalTransactions: website.orders + telegram.orders,
                totalProducts: productsCount,
                totalRevenue: website.revenue + telegram.revenue,
                totalProductsSold: website.items_sold + telegram.items_sold
            }
        };
    } catch (err) {
        console.error("Stats Error:", err);
        return { success: false, error: err.message };
    }
}

// Overwrite legacy methods to use Order truth
export async function calculateTotalRevenue(botId) {
    const res = await getAdminStats(botId);
    return res.success ? res.data.totalRevenue : 0;
}

export async function calculateTotalPcs(botId) {
    const res = await getAdminStats(botId);
    return res.success ? res.data.totalProductsSold : 0;
}

export async function totalTransaksi(botId) {
    const res = await getAdminStats(botId);
    return {
        totalPcs: res.success ? res.data.totalProductsSold : 0,
        totalPendapatan: res.success ? res.data.totalRevenue : 0
    };
}
