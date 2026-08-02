import type { TFunction } from 'i18next'

import type { KitableTemplateSeed } from './kitableTemplates'

function receiptAsset(recordNumber: number) {
  const recordID = `record-${String(recordNumber).padStart(2, '0')}`
  return { assetIds: [`${recordID}-receipt-image`] }
}

const VENDOR_SCHEMA = JSON.stringify({
  type: 'string',
  description: 'The merchant or vendor name only. Preserve the official capitalization visible on the receipt.',
})

const ADDRESS_SCHEMA = JSON.stringify({
  type: 'string',
  description: 'The merchant street address only. Include city, region, postal code, and country when visible.',
})

const STRUCTURED_RECEIPT_SCHEMA = JSON.stringify({
  merchant_name: 'string or null',
  address: 'string or null',
  receipt_date: 'ISO 8601 date string or null',
  currency: 'ISO 4217 currency code or null',
  subtotal: 'number or null',
  tax: 'number or null',
  total: 'number or null',
  payment_method: 'string or null',
  line_items: [{
    description: 'string',
    quantity: 'number or null',
    unit_price: 'number or null',
    amount: 'number or null',
  }],
})

const PLAIN_TEXT_SCHEMA = JSON.stringify({
  type: 'string',
  description: 'Every visible receipt line in reading order. Preserve line breaks and do not add commentary.',
})

export function createReceiptOcrTemplate(t: TFunction<'table'>): KitableTemplateSeed {
  return {
    id: 'receipt-ocr-database',
    title: t('templateLibrary.templates.receiptOcrDatabase.title'),
    description: t('templateLibrary.templates.receiptOcrDatabase.description'),
    documentDescription: 'Upload receipt images and convert them into searchable fields, structured JSON, and plain OCR text.',
    usageCount: 1847,
    icon: 'receipt-text',
    color: 'violet',
    localOnly: true,
    assetManifestPath: 'kition-bundled:/templates/receipt-ocr-database/manifest.json',
    tables: [{
      title: 'Receipts',
      description: 'Receipt images with vision-based extraction for vendor details, categories, JSON, and plain text.',
      fields: [
        { title: 'File Name', type: 'text', primary: true },
        { title: 'Receipt Image', type: 'attachment' },
        {
          title: 'Vendor Name',
          type: 'text',
          aiConfig: {
            type: 'extract',
            sourceFieldTitle: 'Receipt Image',
            schema: VENDOR_SCHEMA,
            enabled: true,
            auto_update: true,
          },
        },
        {
          title: 'Address',
          type: 'text',
          aiConfig: {
            type: 'extract',
            sourceFieldTitle: 'Receipt Image',
            schema: ADDRESS_SCHEMA,
            enabled: true,
            auto_update: true,
          },
        },
        {
          title: 'Category',
          type: 'text',
          aiConfig: {
            type: 'classify',
            sourceFieldTitle: 'Receipt Image',
            categories: ['Food', 'Fuel', 'Software', 'Travel', 'Office supplies', 'Healthcare', 'Others'],
            enabled: true,
            auto_update: true,
          },
        },
        {
          title: 'Structured Data',
          type: 'long_text',
          aiConfig: {
            type: 'extract',
            sourceFieldTitle: 'Receipt Image',
            schema: STRUCTURED_RECEIPT_SCHEMA,
            enabled: true,
            auto_update: true,
          },
        },
        {
          title: 'Plain Text',
          type: 'long_text',
          aiConfig: {
            type: 'extract',
            sourceFieldTitle: 'Receipt Image',
            schema: PLAIN_TEXT_SCHEMA,
            enabled: true,
            auto_update: true,
          },
        },
      ],
      views: [{
        title: 'Overall',
        type: 'grid',
        config: { row_height: 'tall', frozen_column_count: 1 },
        fieldLayouts: [
          { fieldTitle: 'File Name', position: 0, width: 220, frozen: true },
          { fieldTitle: 'Receipt Image', position: 1, width: 160 },
          { fieldTitle: 'Vendor Name', position: 2, width: 210 },
          { fieldTitle: 'Address', position: 3, width: 260 },
          { fieldTitle: 'Category', position: 4, width: 150 },
          { fieldTitle: 'Structured Data', position: 5, width: 360 },
          { fieldTitle: 'Plain Text', position: 6, width: 360 },
        ],
      }],
      records: [
        {
          'File Name': 'strong flour.jpg',
          'Receipt Image': receiptAsset(1),
          'Vendor Name': 'STRONG FLOUR',
          Address: '30 East Coast Road, Singapore',
          Category: 'Food',
          'Structured Data': '{"merchant_name":"STRONG FLOUR","address":"30 East Coast Road, Singapore","currency":"SGD"}',
          'Plain Text': 'STRONG FLOUR\n30 East Coast Road\nThank you for your purchase',
        },
        {
          'File Name': 'Receipt_California.jpg',
          'Receipt Image': receiptAsset(2),
          'Vendor Name': 'BOULEVARD',
          Address: 'One Mission Street, San Francisco, CA',
          Category: 'Food',
          'Structured Data': '{"merchant_name":"BOULEVARD","address":"One Mission Street, San Francisco, CA","currency":"USD"}',
          'Plain Text': 'BOULEVARD\nOne Mission Street\nSan Francisco, CA',
        },
        {
          'File Name': 'openai.png',
          'Receipt Image': receiptAsset(3),
          'Vendor Name': 'OpenAI, LLC',
          Address: '548 Market Street, San Francisco, CA',
          Category: 'Software',
          'Structured Data': '{"merchant_name":"OpenAI, LLC","address":"548 Market Street, San Francisco, CA","currency":"USD"}',
          'Plain Text': 'OpenAI, LLC\n548 Market Street\nSan Francisco, CA',
        },
        {
          'File Name': 'food business center.jpg',
          'Receipt Image': receiptAsset(4),
          'Vendor Name': 'Food Business Center',
          Address: '23232 Java City',
          Category: 'Food',
          'Structured Data': '{"merchant_name":"Food Business Center","address":"23232 Java City"}',
          'Plain Text': 'Food Business Center\n23232 Java City',
        },
        {
          'File Name': 'Mcdonalds receipt.jpg',
          'Receipt Image': receiptAsset(5),
          'Vendor Name': "McDonald's Restaurant",
          Address: '2170 White Plains Road, Bronx, NY',
          Category: 'Food',
          'Structured Data': '{"merchant_name":"McDonald’s Restaurant","address":"2170 White Plains Road, Bronx, NY","currency":"USD"}',
          'Plain Text': "McDonald's Restaurant\n2170 White Plains Road\nBronx, NY",
        },
        {
          'File Name': 'gas_prices.webp',
          'Receipt Image': receiptAsset(6),
          'Vendor Name': 'UNITED PACIFIC 72',
          Address: '1510 NE 42nd Avenue, Portland, OR',
          Category: 'Fuel',
          'Structured Data': '{"merchant_name":"UNITED PACIFIC 72","address":"1510 NE 42nd Avenue, Portland, OR","currency":"USD"}',
          'Plain Text': 'UNITED PACIFIC 72\n1510 NE 42nd Avenue\nPortland, OR',
        },
        {
          'File Name': 'homedepot_receipt3.jpg',
          'Receipt Image': receiptAsset(7),
          'Vendor Name': 'The Home Depot',
          Address: '15360 Bayview Avenue, Aurora, ON',
          Category: 'Others',
          'Structured Data': '{"merchant_name":"The Home Depot","address":"15360 Bayview Avenue, Aurora, ON","currency":"CAD"}',
          'Plain Text': 'The Home Depot\n15360 Bayview Avenue\nAurora, ON',
        },
        {
          'File Name': 'starbucks_receipt.jpg',
          'Receipt Image': receiptAsset(8),
          'Vendor Name': 'STARBUCKS Store',
          Address: '13104 SR-33, Gustine, CA',
          Category: 'Food',
          'Structured Data': '{"merchant_name":"STARBUCKS Store","address":"13104 SR-33, Gustine, CA","currency":"USD"}',
          'Plain Text': 'STARBUCKS Store\n13104 SR-33\nGustine, CA',
        },
        {
          'File Name': 'shell_gas.jpg',
          'Receipt Image': receiptAsset(9),
          'Vendor Name': 'Shell',
          Address: '6101 West Olympic Boulevard, Los Angeles, CA',
          Category: 'Fuel',
          'Structured Data': '{"merchant_name":"Shell","address":"6101 West Olympic Boulevard, Los Angeles, CA","currency":"USD"}',
          'Plain Text': 'Shell\n6101 West Olympic Boulevard\nLos Angeles, CA',
        },
        {
          'File Name': 'Arco gasoline.jpg',
          'Receipt Image': receiptAsset(10),
          'Vendor Name': 'ARCO GASOLINE',
          Address: '2211 S Hoover Street, Los Angeles, CA',
          Category: 'Fuel',
          'Structured Data': '{"merchant_name":"ARCO GASOLINE","address":"2211 S Hoover Street, Los Angeles, CA","currency":"USD"}',
          'Plain Text': 'ARCO GASOLINE\n2211 S Hoover Street\nLos Angeles, CA',
        },
      ],
    }],
  }
}
