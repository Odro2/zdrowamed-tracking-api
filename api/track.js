// api/track.js - Shopify Functions / Node.js Backend
// This handles YunExpress + GLS API integration

const axios = require('axios');

// API Credentials - Store these in environment variables
const YUNEXPRESS_API_KEY = process.env.YUNEXPRESS_API_KEY;
const YUNEXPRESS_CUSTOMER_CODE = process.env.YUNEXPRESS_CUSTOMER_CODE;

/**
 * Main tracking endpoint
 * GET /api/track?number=YT2404070203818
 */
export default async function handler(req, res) {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const { number } = req.query;

    if (!number) {
        return res.status(400).json({ error: 'Missing tracking number' });
    }

    try {
        // Determine if this is order number or tracking number
        const isOrderNumber = number.startsWith('#') || /^\d{1,6}$/.test(number);
        
        let trackingData;
        
        if (isOrderNumber) {
            // Fetch from Shopify order
            trackingData = await getShopifyOrderTracking(number.replace('#', ''));
        } else {
            // Fetch from YunExpress + GLS
            trackingData = await getCombinedTracking(number);
        }

        return res.status(200).json(trackingData);
    } catch (error) {
        console.error('Tracking API error:', error);
        return res.status(500).json({ error: 'Failed to fetch tracking data' });
    }
}

/**
 * Get tracking from Shopify order
 */
async function getShopifyOrderTracking(orderNumber) {
    // Replace with your Shopify Admin API call
    const shopifyDomain = process.env.SHOPIFY_DOMAIN;
    const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

    const response = await axios.get(
        `https://${shopifyDomain}/admin/api/2024-01/orders.json?name=${orderNumber}`,
        {
            headers: {
                'X-Shopify-Access-Token': accessToken
            }
        }
    );

    const order = response.data.orders[0];
    
    if (!order) {
        throw new Error('Order not found');
    }

    const fulfillment = order.fulfillments?.[0];
    const yunexpressTracking = fulfillment?.tracking_number;

    if (!yunexpressTracking) {
        return {
            orderNumber: order.name.replace('#', ''),
            trackingNumber: null,
            status: 'pending',
            events: [
                {
                    timestamp: order.created_at,
                    status: 'Order confirmed',
                    location: 'Warehouse',
                    courier: 'ZdrowaMed'
                }
            ]
        };
    }

    // Fetch from YunExpress + GLS
    return await getCombinedTracking(yunexpressTracking, order.name.replace('#', ''));
}

/**
 * Get combined tracking from YunExpress + GLS
 */
async function getCombinedTracking(yunexpressNumber, orderNumber = null) {
    const yunExpressEvents = await getYunExpressTracking(yunexpressNumber);
    const glsNumber = extractGLSNumber(yunExpressEvents);
    
    let glsEvents = [];
    if (glsNumber) {
        try {
            glsEvents = await getGLSTracking(glsNumber);
        } catch (error) {
            console.log('GLS tracking not available yet:', error);
        }
    }

    // Combine and sort events
    const allEvents = [...yunExpressEvents, ...glsEvents]
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return {
        orderNumber: orderNumber || yunexpressNumber,
        trackingNumber: yunexpressNumber,
        glsTracking: glsNumber,
        events: allEvents
    };
}

/**
 * YunExpress API Integration
 * Documentation: https://www.yunexpress.com/api/tracking
 */
async function getYunExpressTracking(trackingNumber) {
    const apiUrl = 'https://api.yunexpress.com/LMS.API/api/WayBill/GetTrackInfo';

    try {
        const response = await axios.post(apiUrl, {
            CustomerCode: YUNEXPRESS_CUSTOMER_CODE,
            WayBillNumber: trackingNumber
        }, {
            headers: {
                'Authorization': `Basic ${Buffer.from(YUNEXPRESS_API_KEY).toString('base64')}`,
                'Content-Type': 'application/json'
            }
        });

        const data = response.data;

        if (!data.Success || !data.Item) {
            throw new Error('YunExpress tracking not found');
        }

        // Parse YunExpress events
        const trackingDetails = data.Item.TrackingDetails || [];
        
        return trackingDetails.map(detail => ({
            timestamp: detail.ProcessDate,
            status: detail.ProcessContent,
            location: detail.ProcessLocation || '',
            courier: 'Yuntexpress'
        }));

    } catch (error) {
        console.error('YunExpress API error:', error);
        return [];
    }
}

/**
 * GLS Poland API Integration
 * Documentation: https://gls-group.eu/PL/pl/sledzenie-przesylek
 */
async function getGLSTracking(glsNumber) {
    const apiUrl = `https://gls-group.eu/app/service/open/rest/PL/pl/rstt001?match=${glsNumber}`;

    try {
        const response = await axios.get(apiUrl, {
            headers: {
                'Accept': 'application/json'
            }
        });

        const data = response.data;

        if (!data.tuStatus || data.tuStatus.length === 0) {
            throw new Error('GLS tracking not found');
        }

        const parcel = data.tuStatus[0];
        const events = parcel.history || [];

        return events.map(event => ({
            timestamp: event.date,
            status: event.evtDscr,
            location: `${event.address?.city || ''}, ${event.address?.country || 'Poland'}`.trim(),
            courier: 'GLS'
        }));

    } catch (error) {
        console.error('GLS API error:', error);
        return [];
    }
}

/**
 * Extract GLS tracking number from YunExpress events
 */
function extractGLSNumber(events) {
    // Look for "Delivered to local carrier" event with GLS number
    const glsEvent = events.find(e => 
        e.status.toLowerCase().includes('delivered to local carrier') ||
        e.status.toLowerCase().includes('handed over')
    );

    if (!glsEvent) return null;

    // GLS tracking numbers are typically 11 digits
    const glsMatch = glsEvent.status.match(/\b\d{11}\b/);
    return glsMatch ? glsMatch[0] : null;
}

/**
 * Alternative: Direct GLS API with credentials (if you have account)
 */
async function getGLSTrackingWithAuth(glsNumber) {
    // If you have GLS API credentials, use this instead
    const apiUrl = 'https://api.gls-poland.com/tracking'; // Example URL
    const glsApiKey = process.env.GLS_API_KEY;

    try {
        const response = await axios.post(apiUrl, {
            trackingNumber: glsNumber
        }, {
            headers: {
                'Authorization': `Bearer ${glsApiKey}`,
                'Content-Type': 'application/json'
            }
        });

        return response.data.events.map(event => ({
            timestamp: event.timestamp,
            status: event.description,
            location: event.location,
            courier: 'GLS'
        }));

    } catch (error) {
        console.error('GLS Auth API error:', error);
        return [];
    }
}
