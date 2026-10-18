# Rajesh UPIPay gateway (Vercel)

Runs the free UPIPay SDK (https://github.com/iamrobinsharaya/upipay) with Paytm Business.
Cloudflare worker  ->  this project  ->  Paytm.  No SmartUPI.

## 1. Deploy
1. Put this folder in a new GitHub repo (private is fine).
2. vercel.com -> Add New Project -> import the repo -> Deploy.
3. Project -> Settings -> Environment Variables (Production), then Redeploy:

| Name | Value |
|---|---|
| PAYTM_MERCHANT_ID | your Paytm MID (XcKCiU89977098483388) |
| PAYTM_MERCHANT_KEY | Paytm Business dashboard -> Developer Settings -> API keys |
| PAYTM_ENV | `sandbox` first, then `production` |
| BRIDGE_KEY | any long random text (you make it up) |
| SITE_URL | https://therajesh.shop |

## 2. Cloudflare (Pages -> Settings -> Variables and Secrets), then redeploy the site
| Name | Value |
|---|---|
| PAY_GATEWAY_URL | https://YOUR-PROJECT.vercel.app |
| BRIDGE_KEY | the same text as in Vercel |

You can delete SMARTUPI_TOKEN. If PAY_GATEWAY_URL is empty the site falls back to direct UPI QR (counter approves by hand).

## 3. Test
Sandbox first. Then production with a Rs 1 order: pay, and the site must show "Payment received".
After the first install, open package.json and replace "latest" with the exact upipay version npm installed, so updates can't surprise you.
