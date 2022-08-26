const functions = require("firebase-functions");
const admin = require("firebase-admin");
const Twitter = require("twitter");
const { WebClient } = require("@slack/web-api");
admin.initializeApp(functions.config().firebase);
const db = admin.firestore();
const axios = require("axios");
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function collectionId(twitterId, channelId) {
  return `${channelId}-${twitterId}`;
}
// Slackのスラッシュコマンドをパースする
function parseText(text) {
  if (!text) {
    return {};
  }
  const params = text.split(" ");
  let filters = undefined;
  if (params.indexOf("--filters") > 0) {
    filters = params[params.indexOf("--filters") + 1];
  }
  let command = params[0];
  let twitterId = params[1];
  if (twitterId) {
    twitterId = twitterId.trim();
    if (twitterId.startsWith("@")) {
      twitterId = twitterId.substring(1);
    }
  }
  return {
    command,
    twitterId,
    filters,
  };
}

// Slackのコマンドが実行されたときのエントリーポイント
exports.addTwitter2Slack = functions
  .region("asia-northeast2")
  .https.onRequest(async (request, response) => {
    console.log(JSON.stringify(request.body));
    const params = parseText(request.body.text);

    if (!request.body.channel_id || !params.twitterId) {
      response.send(`Bad params: ${request.body.text}`);
      return;
    }
    const channelId = request.body.channel_id;

    switch (params.command) {
      case "add":
        await db
          .collection("twitter2slack")
          .doc(collectionId(params.twitterId, channelId))
          .set({
            twitterId: params.twitterId,
            channelId: channelId,
            filters: params.filters ?? "",
          });
        response.send(
          `${params.twitterId} -> ${request.body.channel_name} 追加しました。`
        );
        return;
        break;
      case "remove":
        await db
          .collection("twitter2slack")
          .doc(collectionId(params.twitterId, channelId))
          .delete();
        response.send(
          `${params.twitterId} -> ${request.body.channel_name} 削除しました。`
        );
        return;
        break;
      default:
        response.send(`Unknown command: ${params.command}`);
        return;
    }

    console.log(request.body.twitter);
    response.send("OK");
  });

exports.twitter2slack = functions
  .region("asia-northeast2")
  .pubsub.schedule("every 2 minutes")
  .timeZone("Asia/Tokyo")
  .onRun(async () => {
    // exports.twitter2slack = functions
    //   .region("asia-northeast2")
    //   .https.onRequest(async (request, response) => {
    try {
      const twitterClient = new Twitter({
        consumer_key: functions.config().twitter.ryohorie3.consumer_key,
        consumer_secret: functions.config().twitter.ryohorie3.consumer_secret,
        access_token_key: functions.config().twitter.ryohorie3.access_token_key,
        access_token_secret:
          functions.config().twitter.ryohorie3.access_token_secret,
      });
      const slackToken = functions.config().slack.bot.token;
      const slackClient = new WebClient(slackToken);

      // 既に登録済みのtweetを集める
      const querySnapshotTweets = await db
        .collection("tweets")
        .orderBy("createdAt", "desc")
        .limit(100)
        .get();
      const tweets = [];
      querySnapshotTweets.forEach((doc) => {
        tweets.push(doc.id);
      });

      console.log(tweets);

      // 登録されているtwitterId -> channelIdを取得
      const querySnapshotTwitter2Slack = await db
        .collection("twitter2slack")
        .get();
      const usernames = [];
      const twitter2slackList = [];
      querySnapshotTwitter2Slack.forEach((doc) => {
        usernames.push(doc.data().twitterId);
        twitter2slackList.push(doc.data());
      });

      // Twitter APIでusersを取得
      const users = await twitterClient.get("users/lookup", {
        screen_name: usernames.join(","),
      });
      for (let user of users) {
        console.log(user);
        if (
          user.status &&
          user.status.text &&
          !user.status.in_reply_to_status_id && // リプライの投稿は除外
          tweets.indexOf(user.status.id_str) < 0 // 既に登録済みだったら除外
        ) {
          const twitter2slacks = twitter2slackList.filter(
            (t2s) => t2s.twitterId === user.screen_name
          );
          for (let twitter2slack of twitter2slacks) {
            // フィルター設定したあったら
            if (twitter2slack.filters) {
              const filters = twitter2slack.filters.split(",");
              const ok = filters.some((filter) =>
                user.status.text.includes(filter)
              );
              if (!ok) {
                continue;
              }
            }
            try {
              const data = {
                channel: twitter2slack.channelId,
                token: slackToken,
                username: user.name,
                icon_url: user.profile_image_url_https,
                text: `https://twitter.com/${user.screen_name}/status/${user.status.id_str}`,
              };
              // slackに投稿
              await slackClient.chat.postMessage(data);
              // firestoreに登録
              data.createdAt = admin.firestore.Timestamp.now();
              await db.collection("tweets").doc(user.status.id_str).set(data);
            } catch (err) {
              // 失敗したやつは握りつぶす
              console.error(err);
            }
          }
        }
      }
    } catch (err) {
      console.error(err);
    }

    return null;
  });
