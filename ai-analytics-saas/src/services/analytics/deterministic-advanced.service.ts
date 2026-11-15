import type { Document } from "mongodb";

type Field = { name: string; types: string[] };
type MongoCollection = { collection: string; fields: Field[] };
type SqlColumn = { name: string; type: string };
type SqlTable = { name: string; columns: SqlColumn[] };
type MongoPlan = { collection: string; pipeline: Document[]; summary: string };
type SqlPlan = { sql: string; summary: string };

const aliases = {
  orders: ["order", "orders", "purchase", "purchases", "sales", "sale", "transactions", "transaction"],
  customers: ["customer", "customers", "client", "clients", "users", "user"],
  products: ["product", "products", "items", "inventory"],
  orderItems: ["orderitem", "orderitems", "order_items", "orderdetails", "order_details", "lineitems", "line_items"],
  customerId: ["customerid", "customer_id", "userid", "user_id", "clientid", "client_id"],
  productId: ["productid", "product_id", "itemid", "item_id", "sku"],
  orderId: ["orderid", "order_id", "purchaseid", "purchase_id"],
  date: ["createdat", "created_at", "orderdate", "order_date", "purchasedat", "purchase_date", "transactiondate", "transaction_date", "date"],
  amount: ["totalamount", "total_amount", "grandtotal", "grand_total", "order_total", "total", "amount", "revenue", "sales"],
  quantity: ["quantity", "qty", "units", "count"],
  price: ["unitprice", "unit_price", "price", "rate", "sellingprice", "selling_price"],
  name: ["name", "productname", "product_name", "title", "customername", "customer_name"],
  email: ["email", "emailaddress", "email_address"],
  id: ["_id", "id", "customerid", "customer_id", "userid", "user_id", "orderid", "order_id", "productid", "product_id"],
};

function norm(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]/g, ""); }
function words(value: string): Set<string> { return new Set(value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean)); }
function pickField(fields: Field[], names: string[], numeric = false): Field | undefined {
  return fields.find(field => names.includes(norm(field.name)) && (!numeric || field.types.some(type => /number|int|long|double|decimal|numeric|float|real/i.test(type))));
}
function pickSqlColumn(columns: SqlColumn[], names: string[], numeric = false): SqlColumn | undefined {
  return columns.find(column => names.includes(norm(column.name)) && (!numeric || /int|numeric|decimal|real|double|float|money/i.test(column.type)));
}
function pickCollection(schema: MongoCollection[], names: string[]): MongoCollection | undefined {
  return schema.find(item => names.includes(norm(item.collection)));
}
function pickTable(tables: SqlTable[], names: string[]): SqlTable | undefined {
  return tables.find(item => names.includes(norm(item.name)));
}
function dateBounds(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { start: start.toISOString(), previous: previous.toISOString(), next: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(), cutoff: new Date(now.getTime() - 90 * 86400000).toISOString() };
}
function mongoPath(field: Field): string { return "$" + field.name; }
function mongoFieldName(field: Field): string { return field.name; }
function quote(identifier: string): string { return '"' + identifier.replace(/"/g, '""') + '"'; }
function sqlField(alias: string, field: SqlColumn): string { return alias + "." + quote(field.name); }

export function buildAdvancedMongoQuery(question: string, schema: MongoCollection[], now = new Date()): MongoPlan | null {
  const q = words(question);
  const text = question.toLowerCase();
  const customers = pickCollection(schema, aliases.customers);
  const orders = pickCollection(schema, aliases.orders);
  const products = pickCollection(schema, aliases.products);
  const orderItems = pickCollection(schema, aliases.orderItems);
  const isCustomerRank = /which customer|most.*customer|top customer|customer.*most|highest.*customer/.test(text);
  const isTopProduct = /top.*(selling|sell|sold).*product|best.?selling product|most.*sold product|product.*sold.*most/.test(text);
  const isRepeatCustomer = /customer.*(more than|over|above).*3.*(order|purchase)|more than 3.*(order|purchase)|ordered.*more than 3/.test(text);
  const isMonthly = /monthly revenue|revenue.*month|month.*revenue|sales.*by month/.test(text);
  const isCompare = /compare.*(this|current).*month.*(last|previous).*month|this month.*last month|current month.*previous month/.test(text);
  const isInactive = /inactive customer|customers.*inactive|customer.*not.*order|no order.*(90|three) days/.test(text);
  const isAverage = /average order value|average.*(order|purchase)|avg.*order/.test(text);
  if (![isCustomerRank, isTopProduct, isRepeatCustomer, isMonthly, isCompare, isInactive, isAverage].some(Boolean)) return null;
  if (!orders && !isInactive) return null;
  const bounds = dateBounds(now);
  const amount = orders ? pickField(orders.fields, aliases.amount, true) : undefined;
  const date = orders ? pickField(orders.fields, aliases.date) : undefined;
  const customerKey = orders ? pickField(orders.fields, aliases.customerId) : undefined;

  if (isInactive) {
    if (!customers || !orders) return null;
    const customerPk = pickField(customers.fields, aliases.id);
    const orderCustomer = pickField(orders.fields, aliases.customerId);
    const orderDate = pickField(orders.fields, aliases.date);
    if (!customerPk || !orderCustomer || !orderDate) return null;
    return {
      collection: customers.collection,
      pipeline: [
        { $lookup: { from: orders.collection, localField: mongoFieldName(customerPk), foreignField: mongoFieldName(orderCustomer), pipeline: [{ $sort: { [mongoFieldName(orderDate)]: -1 } }, { $limit: 1 }, { $project: { [mongoFieldName(orderDate)]: 1, _id: 0 } }], as: "_recentOrders" } },
        { $match: { $or: [{ _recentOrders: { $size: 0 } }, { ["_recentOrders." + mongoFieldName(orderDate)]: { $lt: new Date(bounds.cutoff) } }] } },
        { $limit: 100 },
      ],
      summary: "Customers with no orders in the last 90 days (including customers with no order history).",
    };
  }
  if (!orders || ((isMonthly || isCompare) && (!date || !date.types.includes("date")))) return null;
  if ((isCustomerRank || isRepeatCustomer) && !customerKey) return null;
  if ((isMonthly || isCompare || isAverage) && !amount) return null;

  if (isCustomerRank || isRepeatCustomer) {
    const pipeline: Document[] = [{ $group: { _id: "$" + customerKey!.name, orderCount: { $sum: 1 }, totalSpent: { $sum: amount ? mongoPath(amount) : 0 } } }];
    if (isRepeatCustomer) pipeline.push({ $match: { orderCount: { $gt: 3 } } });
    pipeline.push({ $sort: isCustomerRank ? { totalSpent: -1, orderCount: -1 } : { orderCount: -1 } }, { $limit: 100 });
    if (customers) {
      const pk = pickField(customers.fields, aliases.id);
      if (pk) pipeline.push({ $lookup: { from: customers.collection, localField: "_id", foreignField: pk.name, as: "customer" } }, { $unwind: { path: "$customer", preserveNullAndEmptyArrays: true } });
    }
    return { collection: orders.collection, pipeline, summary: isCustomerRank ? "Customers ranked by total purchase value." : "Customers with more than three orders, ranked by order count." };
  }

  if (isTopProduct) {
    const embedded = pickField(orders.fields, ["items", "products", "orderitems", "order_items", "lineitems", "line_items"]);
    if (!embedded || !embedded.types.includes("array")) return null;
    const productName = ["productname", "product_name", "name", "title"].find(name => schema.some(item => item.collection === orders.collection && item.fields.some(field => norm(field.name) === norm(embedded.name + "." + name))));
    const itemQuantity = ["quantity", "qty", "units"].find(name => schema.some(item => item.collection === orders.collection && item.fields.some(field => norm(field.name) === norm(embedded.name + "." + name))));
    const itemPrice = ["price", "unitprice", "unit_price"].find(name => schema.some(item => item.collection === orders.collection && item.fields.some(field => norm(field.name) === norm(embedded.name + "." + name))));
    const productKey = ["productid", "product_id", "sku", "id"].find(name => schema.some(item => item.collection === orders.collection && item.fields.some(field => norm(field.name) === norm(embedded.name + "." + name))));
    if (!productName && !productKey) return null;
    const groupKey = productName ? "$" + embedded.name + "." + productName : "$" + embedded.name + "." + productKey;
    const pipeline: Document[] = [{ $unwind: "$" + embedded.name }, { $group: { _id: groupKey, unitsSold: { $sum: itemQuantity ? "$" + embedded.name + "." + itemQuantity : 1 }, revenue: { $sum: itemPrice && itemQuantity ? { $multiply: ["$" + embedded.name + "." + itemPrice, "$" + embedded.name + "." + itemQuantity] } : 0 } } }, { $sort: { unitsSold: -1 } }, { $limit: 5 }];
    return { collection: orders.collection, pipeline, summary: "Top five products ranked by units sold, using embedded order line items." };
  }

  if (isMonthly || isCompare) {
    const pipeline: Document[] = [{ $group: { _id: { year: { $year: mongoPath(date!) }, month: { $month: mongoPath(date!) } }, revenue: { $sum: mongoPath(amount!) }, orderCount: { $sum: 1 } } }, { $sort: { "_id.year": 1, "_id.month": 1 } }, { $limit: 100 }];
    if (isCompare) {
      pipeline.unshift({ $match: { [date!.name]: { $gte: new Date(bounds.previous), $lt: new Date(bounds.next) } } });
      return { collection: orders.collection, pipeline, summary: "Revenue and order count for the current and previous calendar month; compare the two returned month rows." };
    }
    return { collection: orders.collection, pipeline, summary: "Monthly revenue grouped by calendar year and month." };
  }
  if (isAverage) return { collection: orders.collection, pipeline: [{ $group: { _id: null, averageOrderValue: { $avg: mongoPath(amount!) }, orderCount: { $sum: 1 } } }, { $project: { _id: 0, averageOrderValue: 1, orderCount: 1 } }], summary: "Average order value across all orders." };
  return null;
}

export function buildAdvancedSqlQuery(question: string, schema: SqlSchemaRowLike[], dialect: "postgresql" | "mysql", now = new Date()): SqlPlan | null {
  const q = words(question);
  const qid = (identifier: string) => dialect === "mysql" ? "`" + identifier.replace(/`/g, "``") + "`" : quote(identifier);
  const text = question.toLowerCase();
  const tables: SqlTable[] = [];
  for (const row of schema) {
    if (typeof row.table_name !== "string" || typeof row.column_name !== "string") continue;
    let table = tables.find(item => item.name === row.table_name);
    if (!table) { table = { name: row.table_name, columns: [] }; tables.push(table); }
    table.columns.push({ name: row.column_name, type: typeof row.data_type === "string" ? row.data_type : "" });
  }
  const orders = pickTable(tables, aliases.orders);
  const customers = pickTable(tables, aliases.customers);
  const items = pickTable(tables, aliases.orderItems);
  const products = pickTable(tables, aliases.products);
  const isCustomerRank = /which customer|most.*customer|top customer|customer.*most|highest.*customer/.test(text);
  const isTopProduct = /top.*(selling|sell|sold).*product|best.?selling product|most.*sold product|product.*sold.*most/.test(text);
  const isRepeatCustomer = /customer.*(more than|over|above).*3.*(order|purchase)|more than 3.*(order|purchase)|ordered.*more than 3/.test(text);
  const isMonthly = /monthly revenue|revenue.*month|month.*revenue|sales.*by month/.test(text);
  const isCompare = /compare.*(this|current).*month.*(last|previous).*month|this month.*last month|current month.*previous month/.test(text);
  const isInactive = /inactive customer|customers.*inactive|customer.*not.*order|no order.*(90|three) days/.test(text);
  const isAverage = /average order value|average.*(order|purchase)|avg.*order/.test(text);
  if (![isCustomerRank, isTopProduct, isRepeatCustomer, isMonthly, isCompare, isInactive, isAverage].some(Boolean)) return null;
  const bounds = dateBounds(now);
  const iso = (value: string) => "'" + value.replace(/'/g, "''") + "'";
  const dateCol = orders && pickSqlColumn(orders.columns, aliases.date);
  const amountCol = orders && pickSqlColumn(orders.columns, aliases.amount, true);
  const customerFk = orders && pickSqlColumn(orders.columns, aliases.customerId);
  const customerPk = customers && pickSqlColumn(customers.columns, aliases.id);
  const orderFk = items && pickSqlColumn(items.columns, aliases.orderId);
  const itemProductFk = items && pickSqlColumn(items.columns, aliases.productId);
  const itemQty = items && pickSqlColumn(items.columns, aliases.quantity, true);
  const itemPrice = items && pickSqlColumn(items.columns, aliases.price, true);
  const productPk = products && pickSqlColumn(products.columns, aliases.id);
  const productName = products && pickSqlColumn(products.columns, aliases.name) || (items && pickSqlColumn(items.columns, aliases.name));
  if (isInactive) {
    if (!customers || !orders || !customerPk || !customerFk || !dateCol) return null;
    return { sql: "SELECT c.* FROM " + qid(customers.name) + " c WHERE NOT EXISTS (SELECT 1 FROM " + qid(orders.name) + " o WHERE o." + qid(customerFk.name) + " = c." + qid(customerPk.name) + " AND o." + qid(dateCol.name) + " >= " + iso(bounds.cutoff) + ") LIMIT 100", summary: "Customers with no orders in the last 90 days (including customers with no order history)." };
  }
  if (!orders) return null;
  if (isCustomerRank || isRepeatCustomer) {
    if (!customerFk) return null;
    const join = customers && customerPk ? " LEFT JOIN " + qid(customers.name) + " c ON c." + qid(customerPk.name) + " = o." + qid(customerFk.name) : "";
    const label = customers && pickSqlColumn(customers.columns, aliases.name) ? ", c." + qid(pickSqlColumn(customers.columns, aliases.name)!.name) + " AS customer_name" : "";
    const having = isRepeatCustomer ? " HAVING COUNT(*) > 3" : "";
    return { sql: "SELECT o." + qid(customerFk.name) + " AS customer_id" + label + ", COUNT(*) AS order_count" + (amountCol ? ", SUM(o." + qid(amountCol.name) + ") AS total_spent" : "") + " FROM " + qid(orders.name) + " o" + join + " GROUP BY o." + qid(customerFk.name) + (label ? ", c." + qid(pickSqlColumn(customers!.columns, aliases.name)!.name) : "") + having + " ORDER BY " + (isCustomerRank && amountCol ? "total_spent DESC, " : "") + "order_count DESC LIMIT 100", summary: isCustomerRank ? "Customers ranked by total purchase value and order count." : "Customers with more than three orders, ranked by order count." };
  }
  if (isTopProduct) {
    if (!items || !itemProductFk || !orderFk || !productName || !itemQty) return null;
    const orderPk = pickSqlColumn(orders.columns, aliases.id);
    if (!orderPk) return null;
    const joinProduct = products && productPk ? " LEFT JOIN " + qid(products.name) + " p ON p." + qid(productPk.name) + " = i." + qid(itemProductFk.name) : "";
    const productLabel = products && pickSqlColumn(products.columns, aliases.name) ? "p." + qid(pickSqlColumn(products.columns, aliases.name)!.name) : "i." + qid(productName.name);
    const revenue = itemPrice ? ", SUM(i." + qid(itemPrice.name) + " * i." + qid(itemQty.name) + ") AS revenue" : "";
    return { sql: "SELECT i." + qid(itemProductFk.name) + " AS product_id, " + productLabel + " AS product_name, SUM(i." + qid(itemQty.name) + ") AS units_sold" + revenue + " FROM " + qid(items.name) + " i JOIN " + qid(orders.name) + " o ON o." + qid(orderPk.name) + " = i." + qid(orderFk.name) + joinProduct + " GROUP BY i." + qid(itemProductFk.name) + ", " + productLabel + " ORDER BY units_sold DESC LIMIT 5", summary: "Top five products ranked by total units sold." };
  }
  if ((isMonthly || isCompare) && (!dateCol || !amountCol)) return null;
  if (isCompare) return { sql: "SELECT CASE WHEN " + qid(dateCol!.name) + " >= " + iso(bounds.start) + " THEN 'current_month' ELSE 'previous_month' END AS period, SUM(" + qid(amountCol!.name) + ") AS revenue, COUNT(*) AS order_count FROM " + qid(orders.name) + " WHERE " + qid(dateCol!.name) + " >= " + iso(bounds.previous) + " AND " + qid(dateCol!.name) + " < " + iso(bounds.next) + " GROUP BY period ORDER BY period LIMIT 2", summary: "Revenue and order count for the current and previous calendar month." };
  if (isMonthly) return { sql: "SELECT EXTRACT(YEAR FROM " + qid(dateCol!.name) + ") AS year, EXTRACT(MONTH FROM " + qid(dateCol!.name) + ") AS month, SUM(" + qid(amountCol!.name) + ") AS revenue, COUNT(*) AS order_count FROM " + qid(orders.name) + " GROUP BY year, month ORDER BY year, month LIMIT 100", summary: "Monthly revenue grouped by calendar year and month." };
  if (isAverage) {
    if (!amountCol) return null;
    return { sql: "SELECT AVG(" + qid(amountCol.name) + ") AS average_order_value, COUNT(*) AS order_count FROM " + qid(orders.name), summary: "Average order value across all orders." };
  }
  return null;
}

export type SqlSchemaRowLike = { table_name?: unknown; column_name?: unknown; data_type?: unknown };
