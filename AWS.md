# DTEK на AWS без S3 та ECR

Збірка: `npm ci --omit=dev && python3 scripts/package-http-lambda.py`. Вивід — один `function.zip` у новому каталозі `artifacts/lambda-http-*`. ZIP не містить браузера й перевіряється на ліміт прямого завантаження 50 МіБ. Доступ до вебформи ДТЕК перевірено локально для Одеси, не з AWS. Перед увімкненням розкладу погодьте регулярне опитування з ДТЕК.

## Розгортання

Усі ресурси створюйте в одному регіоні. Виконуйте нижче з AWS CLI (не `sam deploy`).

1. З кореня репозиторію створіть стек, передаючи шаблон напряму:
   ```sh
   aws cloudformation create-stack --stack-name dtek-monitor --template-body file://template.yaml --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND --parameters file://PATH_TO_PARAMETERS.json
   aws cloudformation wait stack-create-complete --stack-name dtek-monitor
   ```
   У файлі параметрів (масив `ParameterKey` / `ParameterValue`) передайте `RegionCode`, `City`, `Street`, `House`, `TelegramChatId`, `TelegramBotToken`. Не додавайте файл із секретами в git. `ScheduleState` за замовчуванням `DISABLED`.
2. Візьміть `FunctionName` із Outputs стека й завантажте `function.zip` напряму з каталогу збірки:
   ```sh
   aws lambda update-function-code --function-name "$FUNCTION_NAME" --zip-file fileb://function.zip
   aws lambda wait function-updated --function-name "$FUNCTION_NAME"
   ```
3. Перевірте Lambda в консолі із подією `{}`. Перший успіх повертає `baseline_created` і не пише в Telegram. Потім увімкніть Scheduler через оновлення параметра `ScheduleState=ENABLED` у CloudFormation, використавши попередні значення інших параметрів і той самий шаблон. Розклад — `:00`, `:20`, `:40` UTC. Якщо надалі зміните `InlineCode` у шаблоні, CloudFormation може повернути заглушку — оновіть ZIP повторно.

Останній повний JSON і база порівняння зберігаються як gzip у DynamoDB (`id=latest`). Якщо Telegram не підтвердив потрібне сповіщення, попередній стан залишається. Якщо Telegram підтвердив доставку, а запис у DynamoDB не вдався, можливе повторне сповіщення. GitHub Actions цим деплоєм не вимикається.
