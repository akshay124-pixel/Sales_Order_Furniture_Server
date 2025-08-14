const mongoose = require("mongoose");
const XLSX = require("xlsx");
const { Server } = require("socket.io");
const { Order, Notification } = require("../Models/Schema");

const { sendMail } = require("../utils/mailer");
let io;

const initSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: process.env.APP_URL || "http://localhost:3000",
      methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"],
    },
  });

  io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);
    socket.on("join", ({ userId, role }) => {
      socket.join("global");
      console.log(`User ${userId} with role ${role} joined global room`);
    });
    socket.on("disconnect", () => {
      console.log("Client disconnected:", socket.id);
    });
  });

  // Set up MongoDB change stream for inserts only
  try {
    const changeStream = Order.watch([], { fullDocument: "updateLookup" });
    changeStream.on("change", (change) => {
      if (change.operationType === "insert") {
        console.log("New order inserted:", change.fullDocument.orderId);
        io.to("global").emit("orderUpdate", {
          operationType: change.operationType,
          documentId: change.documentKey?._id,
          fullDocument: change.fullDocument || null,
        });
      }
      // Explicitly ignore updates to avoid duplicate notifications
    });

    changeStream.on("error", (error) => {
      console.error("Change stream error:", error);
    });

    changeStream.on("close", () => {
      console.log("Change stream closed");
    });
  } catch (error) {
    console.error("Error setting up change stream:", error);
  }
};
// Shared function to create notifications
function createNotification(req, order, action) {
  const username = req.user?.username || "User";
  const customerName = order.customername || "Unknown";
  const orderId = order.orderId || "N/A";

  return new Notification({
    message: `${action} by ${username} for ${customerName} (Order ID: ${orderId})`,
    timestamp: new Date(),
    isRead: false,
    role: "All",
    userId: req.user?.id || null,
  });
}
// Get all orders
const getAllOrders = async (req, res) => {
  try {
    const { role, id } = req.user;
    let orders;

    if (role === "Admin") {
      orders = await Order.find().populate("createdBy", "username email");
    } else if (role === "Sales") {
      orders = await Order.find({ createdBy: id }).populate(
        "createdBy",
        "username email"
      );
    } else {
      orders = await Order.find().populate("createdBy", "username email");
    }

    res.json(orders);
  } catch (error) {
    console.error("Error in getAllOrders:", error.message);
    res.status(500).json({ error: "Server error" });
  }
};

// Create a new order
const createOrder = async (req, res) => {
  try {
    const {
      name,
      city,
      state,
      pinCode,
      contactNo,
      alterno,
      customerEmail,
      customername,
      products,
      orderType,
      report,
      freightcs,
      installation,
      salesPerson,
      company,
      shippingAddress,
      billingAddress,
      sameAddress,
      total,
      gstno,
      freightstatus,
      installchargesstatus,
      paymentCollected,
      paymentMethod,
      paymentDue,
      neftTransactionId,
      chequeId,
      remarks,
      gemOrderNumber,
      deliveryDate,
      demoDate,
      paymentTerms,

      dispatchFrom,
      fulfillingStatus,
    } = req.body;

    // Validate required fields
    if (!customername || !name || !contactNo || !customerEmail) {
      return res.status(400).json({
        success: false,
        error: "Missing required customer details",
      });
    }
    if (!/^\d{10}$/.test(contactNo)) {
      return res.status(400).json({
        success: false,
        error: "Contact number must be exactly 10 digits",
      });
    }
    if (alterno && !/^\d{10}$/.test(alterno)) {
      return res.status(400).json({
        success: false,
        error: "Alternate contact number must be exactly 10 digits",
      });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
      return res.status(400).json({
        success: false,
        error: "Invalid email address",
      });
    }
    if (!state || !city || !pinCode) {
      return res.status(400).json({
        success: false,
        error: "Missing required address details",
      });
    }
    if (!/^\d{6}$/.test(pinCode)) {
      return res.status(400).json({
        success: false,
        error: "Pin Code must be exactly 6 digits",
      });
    }
    if (!shippingAddress || !billingAddress) {
      return res.status(400).json({
        success: false,
        error: "Missing billing or shipping address",
      });
    }
    if (orderType === "B2G" && !gemOrderNumber) {
      return res.status(400).json({
        success: false,
        error: "Missing GEM Order Number for B2G orders",
      });
    }
    if (orderType === "Demo" && !demoDate) {
      return res.status(400).json({
        success: false,
        error: "Missing Demo Date for Demo orders",
      });
    }
    if (!paymentTerms && orderType !== "Demo") {
      return res.status(400).json({
        success: false,
        error: "Payment Terms is required for non-Demo orders",
      });
    }

    // Validate dispatchFrom
    const validDispatchLocations = [
      "Patna",
      "Bareilly",
      "Ranchi",
      "Morinda",
      "Lucknow",
      "Delhi",
      "Jaipur",
      "Rajasthan",
    ];
    if (dispatchFrom && !validDispatchLocations.includes(dispatchFrom)) {
      return res.status(400).json({
        success: false,
        error: "Invalid dispatchFrom value",
      });
    }

    // Validate products
    for (const product of products) {
      if (
        !product.productType ||
        !product.qty ||
        !product.unitPrice ||
        !product.gst
      ) {
        return res.status(400).json({
          success: false,
          error: "Invalid product data",
          details:
            "Each product must have productType, qty, unitPrice, gst, and warranty",
        });
      }
      if (
        isNaN(Number(product.qty)) ||
        Number(product.qty) <= 0 ||
        isNaN(Number(product.unitPrice)) ||
        Number(product.unitPrice) < 0 ||
        (product.gst !== "including" &&
          (isNaN(Number(product.gst)) || Number(product.gst) < 0))
      ) {
        return res.status(400).json({
          success: false,
          error: "Invalid product data",
          details:
            "qty must be positive, unitPrice must be non-negative, and gst must be valid",
        });
      }
      // Set defaults
      product.size = product.size || "N/A";
      product.spec = product.spec || "N/A";

      product.modelNos = Array.isArray(product.modelNos)
        ? product.modelNos
        : [];
    }

    // Calculate total
    const calculatedTotal =
      products.reduce((sum, product) => {
        const qty = Number(product.qty) || 0;
        const unitPrice = Number(product.unitPrice) || 0;
        const gstRate =
          product.gst === "including" ? 0 : Number(product.gst) || 0;
        return sum + qty * unitPrice * (1 + gstRate / 100);
      }, 0) +
      Number(freightcs || 0) +
      Number(installation || 0);

    const calculatedPaymentDue =
      calculatedTotal - Number(paymentCollected || 0);

    // Create order
    const order = new Order({
      soDate: new Date(),
      name,
      city,
      state,
      pinCode,
      contactNo,
      alterno,
      customerEmail,
      customername,
      products,
      gstno,
      freightcs: freightcs || "",
      freightstatus: freightstatus || "Extra",
      installchargesstatus: installchargesstatus || "Extra",
      installation: installation || "N/A",
      report,
      salesPerson,
      company,
      orderType: orderType || "B2C",
      shippingAddress,
      billingAddress,
      sameAddress,
      total:
        total !== undefined && !isNaN(total) ? Number(total) : calculatedTotal,
      paymentCollected: String(paymentCollected || ""),
      paymentMethod: paymentMethod || "",
      paymentDue:
        paymentDue !== undefined && !isNaN(paymentDue)
          ? String(paymentDue)
          : String(calculatedPaymentDue),
      neftTransactionId: neftTransactionId || "",
      chequeId: chequeId || "",
      remarks,
      gemOrderNumber: gemOrderNumber || "",
      deliveryDate: deliveryDate ? new Date(deliveryDate) : null,
      paymentTerms: paymentTerms || "",
      demoDate: demoDate ? new Date(demoDate) : null,

      createdBy: req.user.id,
      dispatchFrom,
      fulfillingStatus:
        fulfillingStatus ||
        (dispatchFrom === "Morinda" ? "Pending" : "Fulfilled"),
    });

    // Save order
    const savedOrder = await order.save();
    // Send confirmation email
    try {
      const subject = `Order Confirmation - Order #${
        savedOrder.orderId || savedOrder._id
      }`;
      const text = `
Dear ${customername || "Customer"},

Thank you for placing your order with us. Below are your order details:

Order ID: ${savedOrder.orderId || savedOrder._id}
Order Type: ${orderType}
Total: ₹${savedOrder.total}
Date: ${new Date(savedOrder.soDate).toLocaleString("en-IN")}
Dispatch From: ${dispatchFrom}

Products:
${products
  .map(
    (p, i) =>
      `${i + 1}. ${p.productType} - Qty: ${p.qty}, Unit Price: ₹${
        p.unitPrice
      }, GST: ${p.gst}, Brand: ${p.brand}`
  )
  .join("\n")}

Thank you for your business.
– Promark Tech Solutions
`;

      await sendMail(customerEmail, subject, text);
    } catch (mailErr) {
      console.error("Mail sending failed:", mailErr.message);
    }
    // Create notification
    const notification = new Notification({
      message: `New sales order created by ${req.user.username || "User"} for ${
        savedOrder.customername || "Unknown"
      } (Order ID: ${savedOrder.orderId || "N/A"})`,
      timestamp: new Date(),
      isRead: false,
      role: "All",
      userId: req.user.id,
    });
    await notification.save();

    // Emit notification to all connected clients
    io.to("global").emit("newOrder", {
      _id: savedOrder._id,
      customername: savedOrder.customername,
      orderId: savedOrder.orderId,
      notification,
    });
    res.status(201).json({ success: true, data: savedOrder });
  } catch (error) {
    console.error("Error in createOrder:", error);
    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map((err) => err.message);
      return res.status(400).json({
        success: false,
        error: "Validation failed",
        details: messages,
      });
    }
    res.status(500).json({
      success: false,
      error: "Server error",
      details: error.message,
    });
  }
};
// Edit an existing order

const editEntry = async (req, res) => {
  try {
    const orderId = req.params.id;
    const updateData = req.body;

    // Log request body for debugging
    console.log("Edit request body:", updateData);

    // Fetch existing order
    const existingOrder = await Order.findById(orderId);
    if (!existingOrder) {
      return res.status(404).json({
        success: false,
        error: "Order not found",
      });
    }

    // Define allowed fields for update
    const allowedFields = [
      "soDate",
      "dispatchFrom",
      "dispatchDate",
      "name",
      "city",
      "state",
      "pinCode",
      "contactNo",
      "alterno",
      "customerEmail",
      "customername",
      "products",
      "total",
      "gstno",
      "freightstatus",
      "installchargesstatus",
      "paymentCollected",
      "paymentMethod",
      "paymentDue",
      "neftTransactionId",
      "chequeId",
      "freightcs",
      "orderType",
      "installation",
      "installationStatus",
      "remarksByInstallation",
      "dispatchStatus",
      "salesPerson",
      "report",
      "company",
      "installationReport",
      "transporterDetails",
      "docketNo",
      "receiptDate",
      "shippingAddress",
      "billingAddress",
      "sameAddress",
      "invoiceNo",
      "invoiceDate",
      "fulfillingStatus",
      "remarksByProduction",
      "remarksByAccounts",
      "paymentReceived",
      "billNumber",
      "piNumber",
      "remarksByBilling",
      "verificationRemarks",
      "billStatus",
      "completionStatus",
      "fulfillmentDate",
      "remarks",
      "sostatus",
      "gemOrderNumber",
      "deliveryDate",
      "stamp",
      "demoDate",
      "paymentTerms",
      "actualFreight",

      "remarksBydispatch",
    ];

    // Create update object with only provided fields
    const updateFields = {};
    for (const field of allowedFields) {
      if (updateData[field] !== undefined) {
        if (
          field.endsWith("Date") &&
          updateData[field] &&
          !isNaN(new Date(updateData[field]))
        ) {
          updateFields[field] = new Date(updateData[field]);
        } else {
          updateFields[field] = updateData[field];
        }
      }
    }

    // Automatically set completionStatus to
    if (updateData.fulfillingStatus === "Fulfilled") {
      updateFields.completionStatus = "Complete";
      if (!updateFields.fulfillmentDate) {
        updateFields.fulfillmentDate = new Date();
      }
    }

    // Update the order
    const updatedOrder = await Order.findByIdAndUpdate(
      orderId,
      { $set: updateFields },
      { new: true, runValidators: false }
    );

    if (!updatedOrder) {
      return res.status(404).json({
        success: false,
        error: "Order not found",
      });
    } // Send email if dispatchStatus is updated to "Dispatched" or "Delivered"
    if (
      (updateFields.dispatchStatus === "Dispatched" ||
        updateFields.dispatchStatus === "Delivered") &&
      updatedOrder.customerEmail
    ) {
      try {
        const statusText =
          updateFields.dispatchStatus === "Dispatched"
            ? "dispatched"
            : "delivered";
        const subject = `Order ${
          statusText.charAt(0).toUpperCase() + statusText.slice(1)
        } Confirmation - Order #${updatedOrder.orderId || updatedOrder._id}`;
        const text = `
Dear ${updatedOrder.customername || "Customer"},

We are pleased to inform you that your order has been ${statusText}. Below are the order details:

Order ID: ${updatedOrder.orderId || updatedOrder._id}
Order Type: ${updatedOrder.orderType || "N/A"}
Total: ₹${updatedOrder.total || 0}
Dispatch From: ${updatedOrder.dispatchFrom || "N/A"}
${
  updateFields.dispatchStatus === "Dispatched"
    ? `Dispatch Date: ${
        updatedOrder.dispatchDate
          ? new Date(updatedOrder.dispatchDate).toLocaleString("en-IN")
          : "N/A"
      }`
    : `Delivery Date: ${
        updatedOrder.receiptDate
          ? new Date(updatedOrder.receiptDate).toLocaleString("en-IN")
          : "N/A"
      }`
}

Transporter Details: ${updatedOrder.transporterDetails || "N/A"}
Docket No: ${updatedOrder.docketNo || "N/A"}

Products:
${updatedOrder.products
  .map(
    (p, i) =>
      `${i + 1}. ${p.productType} - Qty: ${p.qty}, Unit Price: ₹${
        p.unitPrice
      }, GST: ${p.gst}, Brand: ${p.brand}`
  )
  .join("\n")}

Thank you for your business.
– Promark Tech Solutions
        `;
        await sendMail(updatedOrder.customerEmail, subject, text);
      } catch (mailErr) {
        console.error(
          `${updateFields.dispatchStatus} email sending failed:`,
          mailErr.message
        );
      }
    }

    // Create and save notification
    const notification = new Notification({
      message: `Order updated by ${req.user?.username || "Unknown User"} for ${
        updatedOrder.customername || "Unknown"
      } (Order ID: ${updatedOrder.orderId || "N/A"})`,
      timestamp: new Date(),
      isRead: false,
      role: "All",
      userId: req.user?.id || null,
    });
    await notification.save();

    // Emit notification with standardized structure
    const notificationData = {
      id: notification._id.toString(), // Ensure unique ID
      message: notification.message,
      timestamp: notification.timestamp.toISOString(),
      isRead: notification.isRead,
      role: notification.role,
    };

    io.to("global").emit("updateOrder", {
      _id: updatedOrder._id,
      customername: updatedOrder.customername,
      orderId: updatedOrder.orderId,
      notification: notificationData,
    });

    res.status(200).json({ success: true, data: updatedOrder });
  } catch (error) {
    console.error("Error in editEntry:", error);
    res.status(500).json({
      success: false,
      error: "Server error",
      details: error.message,
    });
  }
};
// Delete an order
const DeleteData = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid order ID" });
    }

    const order = await Order.findById(req.params.id);
    if (!order) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    if (
      req.user.role === "Sales" &&
      order.createdBy.toString() !== req.user.id
    ) {
      return res
        .status(403)
        .json({ success: false, message: "Unauthorized to delete this order" });
    }

    await Order.findByIdAndDelete(req.params.id);
    // Create and save notification
    const notification = createNotification(req, order, "Order deleted");
    await notification.save();

    // Emit notification
    io.to("global").emit("deleteOrder", {
      _id: order._id,
      customername: order.customername,
      orderId: order.orderId,
      notification,
    });
    res
      .status(200)
      .json({ success: true, message: "Order deleted successfully" });
  } catch (error) {
    console.error("Error deleting order:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete order",
      error: error.message,
    });
  }
};

// Parse date strings
const parseDate = (dateStr) => {
  if (!dateStr) return null;
  const date = new Date(String(dateStr).trim());
  return isNaN(date.getTime()) ? null : date;
};

// Bulk upload orders
const bulkUploadOrders = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "No file uploaded",
      });
    }

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json(sheet);

    const orders = [];
    const validDispatchLocations = [
      "Patna",
      "Bareilly",
      "Ranchi",
      "Morinda",
      "Lucknow",
      "Delhi",
      "Jaipur",
      "Rajasthan",
    ];

    for (const row of jsonData) {
      const products = [
        {
          productType: row["Product Type"] || "",
          size: row["Size"] || "N/A",
          spec: row["Specification"] || "N/A",
          qty: Number(row["Quantity"]) || 0,
          unitPrice: Number(row["Unit Price"]) || 0,
          gst: row["GST"] || "18",
          modelNos: row["Model Nos"]
            ? String(row["Model Nos"])
                .split(",")
                .map((m) => m.trim())
            : [],
          brand: row["Brand"] || "",
          warranty:
            row["Warranty"] ||
            (row["Order Type"] === "B2G"
              ? "As Per Tender"
              : row["Product Type"] === "IFPD" && row["Brand"] === "Promark"
              ? "3 Years"
              : "1 Year"),
        },
      ];

      // Validate products
      for (const product of products) {
        if (
          !product.productType ||
          !product.qty ||
          !product.unitPrice ||
          !product.gst ||
          !product.warranty
        ) {
          return res.status(400).json({
            success: false,
            error: `Invalid product data in row: ${JSON.stringify(row)}`,
          });
        }
        if (
          isNaN(Number(product.qty)) ||
          Number(product.qty) <= 0 ||
          isNaN(Number(product.unitPrice)) ||
          (product.gst !== "including" && isNaN(Number(product.gst)))
        ) {
          return res.status(400).json({
            success: false,
            error: `Invalid product data in row: ${JSON.stringify(row)}`,
          });
        }
        if (
          product.productType === "IFPD" &&
          (!product.modelNos || !product.brand)
        ) {
          return res.status(400).json({
            success: false,
            error: `Model Numbers and Brand are required for IFPD products in row: ${JSON.stringify(
              row
            )}`,
          });
        }
      }

      // Calculate total
      const calculatedTotal =
        products.reduce((sum, product) => {
          const qty = Number(product.qty) || 0;
          const unitPrice = Number(product.unitPrice) || 0;
          const gstRate =
            product.gst === "including" ? 0 : Number(product.gst) || 0;
          return sum + qty * unitPrice * (1 + gstRate / 100);
        }, 0) +
        Number(row["Freight Charges"] || 0) +
        Number(row["Installation Charges"] || 0);

      const calculatedPaymentDue =
        calculatedTotal - Number(row["Payment Collected"] || 0);

      // Validate dispatchFrom
      if (
        row["Dispatch From"] &&
        !validDispatchLocations.includes(row["Dispatch From"])
      ) {
        return res.status(400).json({
          success: false,
          error: `Invalid dispatchFrom value in row: ${JSON.stringify(row)}`,
        });
      }

      // Create order object
      const order = {
        soDate: row["SO Date"] ? new Date(row["SO Date"]) : new Date(),
        dispatchFrom: row["Dispatch From"] || "",
        name: row["Contact Person Name"] || "",
        city: row["City"] || "",
        state: row["State"] || "",
        pinCode: row["Pin Code"] || "",
        contactNo: row["Contact No"] || "",
        alterno: row["Alternate No"] || "",
        customerEmail: row["Customer Email"] || "",
        customername: row["Customer Name"] || "",
        products,
        total: calculatedTotal,
        gstno: row["GST No"] || "",
        freightcs: row["Freight Charges"] || "",
        freightstatus: row["Freight Status"] || "Extra",
        installchargesstatus: row["Installation Charges Status"] || "Extra",
        installation: row["Installation Charges"] || "N/A",
        report: row["Reporting Manager"] || "",
        salesPerson: row["Sales Person"] || "",
        company: row["Company"] || "Promark",
        orderType: row["Order Type"] || "B2C",
        shippingAddress: row["Shipping Address"] || "",
        billingAddress: row["Billing Address"] || "",
        sameAddress: row["Same Address"] === "Yes" || false,
        paymentCollected: String(row["Payment Collected"] || ""),
        paymentMethod: row["Payment Method"] || "",
        paymentDue: String(calculatedPaymentDue),
        neftTransactionId: row["NEFT Transaction ID"] || "",
        chequeId: row["Cheque ID"] || "",
        remarks: row["Remarks"] || "",
        gemOrderNumber: row["GEM Order Number"] || "",
        deliveryDate: row["Delivery Date"]
          ? new Date(row["Delivery Date"])
          : null,
        paymentTerms: row["Payment Terms"] || "",

        createdBy: req.user.id,
      };

      orders.push(order);
    }

    // Save orders
    const savedOrders = await Order.insertMany(orders);

    // Emit newOrder events
    savedOrders.forEach((order) => {
      io.emit("newOrder", {
        _id: order._id,
        customername: order.customername,
        orderId: order.orderId,
      });
    });

    res.status(201).json({
      success: true,
      message: "Orders uploaded successfully",
      data: savedOrders,
    });
  } catch (error) {
    console.error("Error in bulkUploadOrders:", error);
    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map((err) => err.message);
      return res.status(400).json({
        success: false,
        error: "Validation failed",
        details: messages,
      });
    }
    res.status(500).json({
      success: false,
      error: "Server error",
      details: error.message,
    });
  }
};

// Export orders to Excel
const exportentry = async (req, res) => {
  try {
    const { role, id } = req.user;
    let orders;

    if (role === "Admin") {
      orders = await Order.find().lean();
    } else if (role === "Sales") {
      orders = await Order.find({ createdBy: id }).lean();
    } else {
      orders = await Order.find().lean();
    }

    if (!Array.isArray(orders) || orders.length === 0) {
      const ws = XLSX.utils.json_to_sheet([]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Orders");

      const fileBuffer = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=orders_${new Date()
          .toISOString()
          .slice(0, 10)}.xlsx`
      );
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      return res.send(fileBuffer);
    }

    // Format entries for Excel
    const formattedEntries = orders.flatMap((entry) => {
      const products =
        Array.isArray(entry.products) && entry.products.length > 0
          ? entry.products
          : [
              {
                productType: "Not Found",
                size: "N/A",
                spec: "N/A",
                qty: 0,
                unitPrice: 0,
                serialNos: [],
                modelNos: [],
                gst: 0,
                brand: "",
              },
            ];

      return products.map((product, index) => {
        const entryData = {
          orderId: entry.orderId || "",
          soDate: entry.soDate
            ? new Date(entry.soDate).toISOString().slice(0, 10)
            : "",
          dispatchFrom: entry.dispatchFrom || "",
          dispatchDate: entry.dispatchDate
            ? new Date(entry.dispatchDate).toISOString().slice(0, 10)
            : "",
          name: entry.name || "",
          city: entry.city || "",
          state: entry.state || "",
          pinCode: entry.pinCode || "",
          contactNo: entry.contactNo || "",
          alterno: entry.alterno || "",
          customerEmail: entry.customerEmail || "",
          customername: entry.customername || "",
        };

        const productData = {
          productType: product.productType || "",
          size: product.size || "N/A",
          spec: product.spec || "N/A",
          qty: product.qty || 0,
          unitPrice: product.unitPrice || 0,

          modelNos: Array.isArray(product.modelNos)
            ? product.modelNos.join(", ")
            : "",
          gst: product.gst || 0,
        };

        const conditionalData =
          index === 0
            ? {
                total: entry.total || 0,
                paymentCollected: entry.paymentCollected || "",
                paymentMethod: entry.paymentMethod || "",
                paymentDue: entry.paymentDue || "",
                neftTransactionId: entry.neftTransactionId || "",
                chequeId: entry.chequeId || "",
                freightcs: entry.freightcs || "",
                freightstatus: entry.freightstatus || "",
                installchargesstatus: entry.installchargesstatus || "",
                gstno: entry.gstno || "",
                orderType: entry.orderType || "Private",
                installation: entry.installation || "N/A",
                installationStatus: entry.installationStatus || "Pending",
                remarksByInstallation: entry.remarksByInstallation || "",
                dispatchStatus: entry.dispatchStatus || "Not Dispatched",
                salesPerson: entry.salesPerson || "",
                report: entry.report || "",
                company: entry.company || "Promark",

                transporterDetails: entry.transporterDetails || "",
                docketNo: entry.docketNo || "",
                shippingAddress: entry.shippingAddress || "",
                billingAddress: entry.billingAddress || "",
                invoiceNo: entry.invoiceNo || "",
                fulfillingStatus: entry.fulfillingStatus || "Pending",
                remarksByProduction: entry.remarksByProduction || "",
                remarksByAccounts: entry.remarksByAccounts || "",
                paymentReceived: entry.paymentReceived || "Not Received",
                billNumber: entry.billNumber || "",
                piNumber: entry.piNumber || "",
                remarksByBilling: entry.remarksByBilling || "",
                verificationRemarks: entry.verificationRemarks || "",
                billStatus: entry.billStatus || "Pending",
                completionStatus: entry.completionStatus || "In Progress",
                remarks: entry.remarks || "",
                sostatus: entry.sostatus || "Pending for Approval",
              }
            : {
                total: "",
                paymentCollected: "",
                paymentMethod: "",
                paymentDue: "",
                neftTransactionId: "",
                chequeId: "",
                freightcs: "",
                freightstatus: "",
                installchargesstatus: "",
                gstno: "",
                orderType: "",
                installation: "",
                installationStatus: "",
                remarksByInstallation: "",
                dispatchStatus: "",
                salesPerson: "",
                report: "",
                company: "",

                transporterDetails: "",
                docketNo: "",
                shippingAddress: "",
                billingAddress: "",
                invoiceNo: "",
                fulfillingStatus: "",
                remarksByProduction: "",
                remarksByAccounts: "",
                paymentReceived: "",
                billNumber: "",
                piNumber: "",
                remarksByBilling: "",
                verificationRemarks: "",
                billStatus: "",
                completionStatus: "",
                remarks: "",
                sostatus: "",
              };

        const dateData = {
          receiptDate: entry.receiptDate
            ? new Date(entry.receiptDate).toISOString().slice(0, 10)
            : "",
          invoiceDate: entry.invoiceDate
            ? new Date(entry.invoiceDate).toISOString().slice(0, 10)
            : "",
          fulfillmentDate: entry.fulfillmentDate
            ? new Date(entry.fulfillmentDate).toISOString().slice(0, 10)
            : "",
        };

        return {
          ...entryData,
          ...productData,
          ...conditionalData,
          ...dateData,
        };
      });
    });

    const ws = XLSX.utils.json_to_sheet(formattedEntries);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Orders");

    const fileBuffer = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=orders_${new Date()
        .toISOString()
        .slice(0, 10)}.xlsx`
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.send(fileBuffer);
  } catch (error) {
    console.error("Error in exportentry:", error);
    res.status(500).json({
      success: false,
      message: "Failed to export orders",
      error: error.message,
    });
  }
};

// Fetch finished goods orders
const getFinishedGoodsOrders = async (req, res) => {
  try {
    const orders = await Order.find({
      fulfillingStatus: "Fulfilled",
      stamp: { $ne: "Received" },
    }).populate("createdBy", "username email");
    res.status(200).json({ success: true, data: orders });
  } catch (error) {
    console.error("Error in getFinishedGoodsOrders:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch finished goods orders",
      error: error.message,
    });
  }
};
// Fetch verification orders
const getVerificationOrders = async (req, res) => {
  try {
    const orders = await Order.find({
      paymentTerms: { $in: ["100% Advance", "Partial Advance"] },
      sostatus: { $nin: ["Accounts Approved", "Approved"] },
    }).populate("createdBy", "username email");
    res.json({ success: true, data: orders });
  } catch (error) {
    console.error("Error in getVerificationOrders:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch verification orders",
      error: error.message,
    });
  }
};
// Fetch bill orders
const getBillOrders = async (req, res) => {
  try {
    const orders = await Order.find({
      sostatus: "Approved",
      billStatus: { $ne: "Billing Complete" },
    }).populate("createdBy", "username email");
    res.json({ success: true, data: orders });
  } catch (error) {
    console.error("Error in getBillOrders:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch bill orders",
      error: error.message,
    });
  }
};
// Fetch installation orders

const getInstallationOrders = async (req, res) => {
  try {
    const orders = await Order.find({
      dispatchStatus: "Delivered",
      // stamp: "Received",
      installationReport: { $ne: "Yes" }, //
      installationStatus: {
        $in: [
          "Pending",
          "In Progress",
          "Failed",
          "Completed",
          "Hold by Salesperson",
          "Hold by Customer",
          "Site Not Ready",
        ],
      },
    }).populate("createdBy", "username email");
    res.json({ success: true, data: orders });
  } catch (error) {
    console.error("Error in getInstallationOrders:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch installation orders",
      error: error.message,
    });
  }
};

// Fetch accounts orders
const getAccountsOrders = async (req, res) => {
  try {
    const orders = await Order.find({
      installationStatus: "Completed",
      paymentReceived: { $ne: "Received" },
    }).populate("createdBy", "username email");

    res.json({ success: true, data: orders });
  } catch (error) {
    console.error("Error in getAccountsOrders:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch accounts orders",
      error: error.message,
    });
  }
};

// Fetch production approval orders
const getProductionApprovalOrders = async (req, res) => {
  try {
    const orders = await Order.find({
      $or: [
        { sostatus: "Accounts Approved" },
        {
          $and: [
            { sostatus: "Pending for Approval" },
            { paymentTerms: "Credit" },
          ],
        },
      ],
    }).populate("createdBy", "username email");
    res.json({ success: true, data: orders });
  } catch (error) {
    console.error("Error in getProductionApprovalOrders:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch production approval orders",
      error: error.message,
    });
  }
};

// Fetch production orders
const getProductionOrders = async (req, res) => {
  try {
    const dispatchFromOptions = [
      "Patna",
      "Bareilly",
      "Ranchi",
      "Lucknow",
      "Delhi",
      "Jaipur",
      "Rajasthan",
    ];

    const orders = await Order.find({
      sostatus: "Approved",
      dispatchFrom: { $nin: dispatchFromOptions },
      fulfillingStatus: { $ne: "Fulfilled" },
    }).lean();

    res.status(200).json({ success: true, data: orders });
  } catch (error) {
    console.error("Error in getProductionOrders:", error.message);
    res.status(500).json({
      success: false,
      message: "Error fetching production orders",
      error: error.message,
    });
  }
}; // Fetch notifications
const getNotifications = async (req, res) => {
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized: User not authenticated",
      });
    }
    console.log("Fetching notifications for user:", req.user.id);
    const notifications = await Notification.find({ role: "All" })
      .sort({ timestamp: -1 })
      .limit(50);
    console.log("Notifications found:", notifications.length);
    res.status(200).json({ success: true, data: notifications });
  } catch (error) {
    console.error("Error in getNotifications:", {
      message: error.message,
      stack: error.stack,
      name: error.name,
    });
    res.status(500).json({
      success: false,
      message: "Failed to fetch notifications",
      error: error.message,
    });
  }
};

// Mark notifications as read
const markNotificationsRead = async (req, res) => {
  try {
    await Notification.updateMany({ role: "All" }, { isRead: true });
    res
      .status(200)
      .json({ success: true, message: "Notifications marked as read" });
  } catch (error) {
    console.error("Error in markNotificationsRead:", error.stack);
    res.status(500).json({
      success: false,
      message: "Failed to mark notifications as read",
      error: error.message,
    });
  }
};

// Clear notifications
const clearNotifications = async (req, res) => {
  try {
    await Notification.deleteMany({ role: "All" });
    res.status(200).json({ success: true, message: "Notifications cleared" });
  } catch (error) {
    console.error("Error in clearNotifications:", error.stack);
    res.status(500).json({
      success: false,
      message: "Failed to clear notifications",
      error: error.message,
    });
  }
};
module.exports = {
  initSocket,
  getAllOrders,
  createOrder,
  editEntry,
  DeleteData,
  bulkUploadOrders,
  exportentry,
  getFinishedGoodsOrders,
  getVerificationOrders,
  getProductionApprovalOrders,
  getBillOrders,
  getInstallationOrders,
  getAccountsOrders,
  getProductionOrders,
  getNotifications,
  markNotificationsRead,
  clearNotifications,
};
