# Rivaida WooCommerce + Chatwoot Panel v7.6

Panel multi-país Chile/Colombia para Chatwoot, WooCommerce, Dropi, Flow/Woo payment links, Redis, catálogo rápido y pagos WooCommerce.

## Cambios v7.6

- Menú **Credenciales** dentro de la interfaz para guardar Woo Chile, Woo Colombia, Chatwoot, Flow y dominio público sin entrar al `.env`.
- Las credenciales se guardan en PostgreSQL en `app_settings` y se aplican en runtime.
- Envío de producto a conversación con **imagen adjunta real** usando Chatwoot API multipart. Si Chatwoot o WhatsApp rechazan el adjunto, usa enlace de imagen como respaldo.
- Soporte multi-país por tienda: Chile (`cl`) y Colombia (`co`).
- Mantiene etiquetas y atributos de Chatwoot.

## Variables mínimas iniciales en EasyPanel

Deja solo lo necesario para arrancar. El resto se puede editar desde el panel.

```env
NODE_ENV=production
PORT=3001
PUBLIC_BASE_URL=https://app.rivaida.cl
ALLOWED_ORIGINS=https://app.rivaida.cl,https://www.chatriva.com,https://chatriva.com,https://www.rivaida.cl,https://rivaida.cl

PANEL_USER=admin
PANEL_PASSWORD=admin123
PANEL_APP_TOKEN=panel_seguro_2026

DATABASE_URL=postgres://paneluser:TU_PASSWORD@chatriva-ai_panel-postgres:5432/paneldb?sslmode=disable
REDIS_URL=redis://default:TU_PASSWORD@chatriva-ai_panel-redis:6379

DEFAULT_STORE=cl
CHATWOOT_SEND_IMAGE_ATTACHMENT=true
```

Luego entra al panel y presiona **Credenciales** para llenar:

- Woo Chile: `WC_URL`, `WC_KEY`, `WC_SECRET`, `WOO_FLOW_GATEWAY_ID`.
- Woo Colombia: `CO_WC_URL`, `CO_WC_KEY`, `CO_WC_SECRET`, `CO_WOO_PAYMENT_GATEWAY_ID`.
- Chatwoot: `CHATWOOT_URL`, `CHATWOOT_API_KEY`, `CHATWOOT_ACCOUNT_ID`.
- Flow directo opcional.

## Dockerfile en EasyPanel

- Compilación: Dockerfile
- Archivo: Dockerfile
- Ruta de compilación: `/`
- Proxy: puerto `3001`

## Chatwoot Dashboard App

URL recomendada:

```text
https://app.rivaida.cl/?panel_token=panel_seguro_2026
```

La app toma los datos de la conversación mediante `window.postMessage` de Chatwoot y también puede leer la conversación por API si necesita detectar email.

## Envío de imagen por WhatsApp

El botón **Enviar a conversación** intenta adjuntar la imagen del producto/variación como archivo real en Chatwoot. Para que llegue al WhatsApp del cliente, la conversación debe estar dentro de una ventana válida de WhatsApp o usar las reglas del proveedor/conector que tengas configurado. Si el canal no permite adjuntos, el panel envía texto con el enlace de imagen como respaldo.


## v7.6 Colombia: Wompi, Bold, contra entrega y copia para Dropi

Esta version agrega metodos sugeridos para Colombia: contra entrega (`cod`), Wompi, Bold, PSE, Mercado Pago, PayU, ePayco y transferencia. Los IDs reales dependen del plugin instalado en WooCommerce; puedes cambiarlos desde el menu Credenciales.

Tambien agrega el bloque **Venta rapida / Dropi Colombia** para copiar datos del cliente, direccion, ciudad, documento, productos, SKU, variacion, metodo de pago y total. Sirve para pegar rapidamente en Dropi u otra plataforma cuando la venta se cierra desde Chatwoot.

Variables opcionales nuevas:

```env
CO_COD_GATEWAY_ID=cod
CO_WOMPI_GATEWAY_ID=wompi
CO_BOLD_GATEWAY_ID=bold
CO_PSE_GATEWAY_ID=pse
CO_MERCADO_PAGO_GATEWAY_ID=mercadopago
CO_EPAYCO_GATEWAY_ID=epayco
CO_PAYU_GATEWAY_ID=payu
CO_BANK_TRANSFER_GATEWAY_ID=bacs
```

Si tus plugins usan otros IDs, ajustalos en Credenciales dentro del panel.


## v7.6
- Métodos de pago se cargan automáticamente desde WooCommerce para Chile y Colombia.
- Si WooCommerce no retorna métodos, Colombia muestra sugeridos: Wompi, Bold, PSE, Mercado Pago, ePayco, PayU, transferencia y contra entrega.
- Se corrigió filtro de ofertas usando `on_sale` y `sale_price` de WooCommerce.
- El estado visual ya no muestra nombres técnicos de base de datos; usa loader y estados amigables.
- Venta rápida Colombia/Dropi: copia datos del chat, cliente, dirección, productos, pago y total para pegar en plataforma externa.


## v7.9 - Pagos y envios Woo automaticos

Esta version lee desde WooCommerce los metodos de pago activos y tambien los metodos de envio activos configurados en las zonas de envio. En el checkout del panel el agente selecciona metodo de pago y metodo de envio; al crear el pedido se envia `shipping_lines` a WooCommerce.

Las credenciales ya no necesitan editarse en `.env`: entra al panel, abre **Credenciales**, guarda Woo Chile, Woo Colombia, Chatwoot y Flow. El `.env` queda solo para arrancar el servicio, dominio, Redis/PostgreSQL y usuario del panel.


## v7.9

- Credenciales en modal independiente para no romper la página.
- Selector de variaciones en modal con bloqueo de opciones sin stock.
- No permite agregar ni enviar productos/variaciones sin stock.
- Notificaciones visuales en pantalla para carrito, conexión Chatwoot, credenciales y errores.


## v7.9
- Credenciales en modal con mejor distribución.
- IA opcional: OpenAI, DeepSeek, Gemini o webhook.
- Cambio automático de tienda por inbox de Chatwoot, etiquetas o código de país del teléfono (+56 Chile, +57 Colombia).
- Nuevas variables: CHATWOOT_INBOX_STORE_MAP, CL_CHATWOOT_INBOX_IDS, CO_CHATWOOT_INBOX_IDS, AUTO_STORE_BY_PHONE, AI_PROVIDER, OPENAI_API_KEY, DEEPSEEK_API_KEY, GEMINI_API_KEY.
