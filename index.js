const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const axios = require("axios");
const qrcode = require("qrcode");

admin.initializeApp();
const db = admin.database();

const app = express();
app.use(express.json());

// --- CONFIGURATION ---
const WHATSAPP_TOKEN = functions.config().whatsapp.token; // Set in Firebase config
const VERIFY_TOKEN = "BENGAL_HONEY_WEBHOOK";
const WHATSAPP_API_VERSION = "v18.0";
const PHONE_NUMBER_ID = "YOUR_PHONE_NUMBER_ID"; // Get from Meta App

// --- WHATSAPP HELPER ---
async function sendWhatsAppMessage(to, message) {
    const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${PHONE_NUMBER_ID}/messages`;
    try {
        await axios.post(url, { messaging_product: "whatsapp", to: to, ...message }, {
            headers: { "Authorization": `Bearer ${WHATSAPP_TOKEN}` }
        });
    } catch (error) {
        console.error("Error sending message:", JSON.stringify(error.response.data, null, 2));
    }
}

// --- WEBHOOK VERIFICATION ---
app.get("/webhook", (req, res) => {
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
        res.status(200).send(req.query["hub.challenge"]);
    } else {
        res.sendStatus(403);
    }
});

// --- MAIN WEBHOOK LOGIC ---
app.post("/webhook", async (req, res) => {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const userRef = db.ref(`users/${from}`);
    const snapshot = await userRef.once('value');
    const userData = snapshot.val() || {};
    let currentState = userData.state || 'GREETING';

    let userMessageText = '';
    if (message.type === 'text') {
        userMessageText = message.text.body.toLowerCase();
    } else if (message.type === 'interactive' && message.interactive.type === 'button_reply') {
        userMessageText = message.interactive.button_reply.id;
    } else if (message.type === 'interactive' && message.interactive.type === 'list_reply') {
        userMessageText = message.interactive.list_reply.id;
    }

    if (userMessageText === 'hi' || userMessageText === 'main_menu') currentState = 'GREETING';

    switch (currentState) {
        case 'GREETING':
            await sendWelcomeMessage(from);
            await userRef.update({ state: 'AWAITING_CHOICE' });
            break;

        case 'AWAITING_CHOICE':
            if (userMessageText === 'place_order') {
                await sendProductList(from);
                await userRef.update({ state: 'AWAITING_PRODUCT_SELECTION' });
            } // ... other choices like cancel_order can be added here
            break;

        case 'AWAITING_PRODUCT_SELECTION':
            const selectedProductId = userMessageText;
            const productSnap = await db.ref(`products/${selectedProductId}`).once('value');
            if (productSnap.exists()) {
                const product = productSnap.val();
                const newOrder = { productId: selectedProductId, productName: product.name, price: product.price };
                await userRef.update({ state: 'AWAITING_NAME', currentOrder: newOrder });
                await sendWhatsAppMessage(from, { type: 'text', text: { body: `You've selected ${product.name}.\n\nLet's get your details. What is your full name?` } });
            }
            break;
        
        // ... The rest of the order flow (AWAITING_NAME, ADDRESS, etc.) is the same as the previous RTDB version.
        // It reads from `userData.currentOrder` which is now set dynamically.

        case 'AWAITING_NAME':
            await userRef.update({ 'currentOrder/name': message.text.body, state: 'AWAITING_ADDRESS' });
            await sendWhatsAppMessage(from, { type: 'text', text: { body: "Thank you. What is your full address?" } });
            break;

        case 'AWAITING_ADDRESS':
            await userRef.update({ 'currentOrder/address': message.text.body, state: 'AWAITING_DISTRICT' });
            await sendWhatsAppMessage(from, { type: 'text', text: { body: "Got it. Which district?" } });
            break;

        case 'AWAITING_DISTRICT':
            await userRef.update({ 'currentOrder/district': message.text.body, state: 'AWAITING_PINCODE' });
            await sendWhatsAppMessage(from, { type: 'text', text: { body: "And the PIN code?" } });
            break;

        case 'AWAITING_PINCODE':
            await userRef.update({ 'currentOrder/pincode': message.text.body, state: 'AWAITING_STATE' });
            await sendWhatsAppMessage(from, { type: 'text', text: { body: "Finally, which state?" } });
            break;

        case 'AWAITING_STATE':
            await userRef.update({ 'currentOrder/state': message.text.body, state: 'AWAITING_PAYMENT_CHOICE' });
            await sendPaymentChoiceMessage(from);
            break;

        case 'AWAITING_PAYMENT_CHOICE':
            if (userMessageText === 'online_payment') {
                await handleOnlinePayment(from, userData.currentOrder);
                await userRef.update({ state: 'AWAITING_TRANSACTION_ID' });
            } else if (userMessageText === 'cod') {
                await finalizeOrder(from, userData.currentOrder, { paymentMethod: 'COD' });
                await userRef.set({ state: 'GREETING' }); // Reset state
            }
            break;

        case 'AWAITING_TRANSACTION_ID':
            const transactionId = message.text.body;
            await finalizeOrder(from, userData.currentOrder, { paymentMethod: 'Online', transactionId: transactionId });
            await userRef.set({ state: 'GREETING' }); // Reset state
            break;
    }
    res.sendStatus(200);
});

// --- MESSAGE TEMPLATES ---

async function sendWelcomeMessage(to) {
    await sendWhatsAppMessage(to, { type: "interactive", interactive: { type: "button", header: { type: "text", text: "Welcome to Bengal Honey!" }, body: { text: "How can we help you today?" }, action: { buttons: [{ type: "reply", reply: { id: "place_order", title: "🛍️ Place Order" } }, { type: "reply", reply: { id: "cancel_order", title: "❌ Cancel Order" } }] } } });
}

async function sendProductList(to) {
    const productsSnap = await db.ref('products').once('value');
    if (!productsSnap.exists()) {
        await sendWhatsAppMessage(to, { type: 'text', text: { body: "Sorry, we are currently not selling any products." } });
        return;
    }
    const products = productsSnap.val();
    const rows = Object.entries(products).map(([id, product]) => ({
        id: id,
        title: product.name,
        description: `₹${product.price} - ${product.description}`
    }));

    await sendWhatsAppMessage(to, { type: "interactive", interactive: { type: "list", header: { type: "text", text: "Our Products" }, body: { text: "Please select a product from the list below." }, action: { button: "View Products", sections: [{ title: "Available Honey", rows: rows }] } } });
}

async function handleOnlinePayment(to, orderDetails) {
    const upiId = (await db.ref('settings/payment/upi_id').once('value')).val();
    if (!upiId) {
        await sendWhatsAppMessage(to, { type: 'text', text: { body: "Sorry, online payment is currently unavailable." } });
        return;
    }
    const upiLink = `upi://pay?pa=${upiId}&pn=Bengal%20Honey&am=${orderDetails.price}&cu=INR`;
    await sendWhatsAppMessage(to, { type: 'text', text: { body: `Please pay ₹${orderDetails.price} using the UPI ID: ${upiId}\n\nAfter payment, please reply with your Transaction ID.` } });
}

async function finalizeOrder(to, orderData, paymentInfo) {
    const newOrderRef = db.ref('orders').push();
    const finalOrder = { id: newOrderRef.key, customerPhone: to, ...orderData, ...paymentInfo, status: 'Pending', timestamp: admin.database.ServerValue.TIMESTAMP };
    await newOrderRef.set(finalOrder);
    await sendWhatsAppMessage(to, { type: 'text', text: { body: `✅ Thank you! Your order has been confirmed.\n\nYour Order ID is: *${newOrderRef.key}*` } });
}

// ... other functions like sendPaymentChoiceMessage remain the same ...

exports.bengalHoneyAgent = functions.https.onRequest(app);
