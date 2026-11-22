# DTEK Monitor на AWS

Функція Lambda збирає дані ДТЕК без браузера, порівнює успішні знімки в DynamoDB і надсилає потрібні сповіщення напряму через Telegram Bot API. Розклад запускає EventBridge Scheduler кожні 20 хвилин за UTC. GitHub Actions для моніторингу чи релізів у репозиторії не використовуються.

HTTP-колектор перевірено локально для Одеси; це не гарантує, що AWS завжди отримає ту саму сторінку. Перед регулярним опитуванням узгодьте доступ із ДТЕК. Не обходьте CAPTCHA, 403, 429 чи інше блокування.

## Вимоги

- AWS CLI v2 з доступом до потрібного акаунта й регіону.
- Node.js 22 та Python 3.
- Локальний файл параметрів CloudFormation; не додавайте його до git, бо він містить Telegram token і адресу.

## Перша інсталяція

З кореня репозиторію створіть `parameters.json` як масив `ParameterKey` / `ParameterValue` для `RegionCode`, `City`, `Street`, `House`, `TelegramChatId`, `TelegramBotToken` і `ScheduleState=DISABLED`. `City` може бути порожнім, якщо це дозволяє регіон. Не передавайте секрети в git або публічні логи.

Створіть стек один раз:

```sh
aws cloudformation create-stack \
  --stack-name dtek-monitor \
  --template-body file://template.yaml \
  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
  --parameters file://parameters.json \
  --region eu-north-1
aws cloudformation wait stack-create-complete --stack-name dtek-monitor --region eu-north-1
```

Розгорніть ZIP, поки розклад вимкнений:

```sh
npm ci --omit=dev
python3 scripts/package-http-lambda.py
```

Скрипт надрукує повний шлях до `function.zip` у `artifacts/lambda-http-*`. Використайте саме його:

```sh
export AWS_REGION=eu-north-1
export STACK_NAME=dtek-monitor
export ZIP=/absolute/path/to/artifacts/lambda-http-.../function.zip
export FUNCTION_NAME="$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`FunctionName`].OutputValue' \
  --output text)"

aws lambda update-function-code \
  --function-name "$FUNCTION_NAME" --region "$AWS_REGION" \
  --zip-file "fileb://$ZIP"
aws lambda wait function-updated-v2 --function-name "$FUNCTION_NAME" --region "$AWS_REGION"
aws lambda get-function-configuration --function-name "$FUNCTION_NAME" \
  --region "$AWS_REGION" \
  --query '{State:State,Update:LastUpdateStatus,Runtime:Runtime,Handler:Handler}'
```

Перевірте, що стан `Active`, а `LastUpdateStatus` — `Successful`. За бажанням звірте `CodeSha256` із ZIP:

```sh
openssl dgst -sha256 -binary "$ZIP" | openssl base64 -A
```

Після цього перевірте стан розкладу без запуску Lambda:

```sh
aws scheduler get-schedule --name MonitorEvery20Minutes --group-name default \
  --region "$AWS_REGION" --query '{State:State,Expression:ScheduleExpression}'
```

Очікуваний вираз — `cron(0,20,40 * * * ? *)`. Увімкнення або вимкнення виконуйте через `ScheduleState` у CloudFormation, передаючи решту попередніх параметрів без змін. Не вмикайте розклад, доки не погодили регулярне опитування з ДТЕК.

## Оновлення коду

Для подальших змін коду не потрібно оновлювати CloudFormation-стек: зберіть ZIP і повторіть `update-function-code`, waiter та перевірку конфігурації з команд вище. Це не змінює розклад, DynamoDB-таблицю чи змінні середовища. Зміни інфраструктури, параметрів або шаблону виконуйте окремим CloudFormation update, зберігаючи попередні значення параметрів і секретів.

Перед деплоєм запускайте локальні автоматизовані тести:

```sh
npm ci
npm test
python3 scripts/package-http-lambda.py
```

Не викликайте Lambda вручну як smoke test: її handler робить зовнішній запит до ДТЕК і може надіслати Telegram-повідомлення. Тестуйте локально моками; перевіряйте CloudWatch Logs після її наступного погодженого запуску.

## Діагностика

Після неуспішного запуску:

```sh
aws logs tail "/aws/lambda/$FUNCTION_NAME" --since 1h --region "$AWS_REGION"
```

Якщо сторінка повернулася без очікуваних полів, запис `DTEK page parse failed` містить HTTP-статус, ознаку редиректу, шлях, тип і розмір відповіді та наявність маркерів `streets`, `fact`, `preset`. Тіло сторінки, cookies і секрети не логуються. Помилка збору не замінює попередній успішний знімок; після Telegram-помилки стан також не просувається, щоб не втратити сповіщення.

## Стан і вартість

Останній успішний знімок та стан порівняння зберігаються разом у DynamoDB (`id=latest`, gzip). Перше успішне виконання створює baseline і не надсилає сповіщення. Якщо Telegram підтвердив доставку, а запис стану не вдався, наступний запуск може повторити сповіщення.

Шаблон задає Lambda 2048 MiB / 75 секунд, таблицю provisioned 5 RCU / 20 WCU та CloudWatch log retention 7 днів. Ці ресурси використовують спільні безкоштовні ліміти акаунта; безкоштовний ліміт не є жорстким обмежувачем витрат. Перевіряйте Free Tier usage і AWS Budgets у Billing.
