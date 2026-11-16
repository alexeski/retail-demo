# Spotter usage limits: demo talk track

About 12 minutes. The app is Storeloom's **Spotter usage limits demo** page (`/spotter-limits`): ThoughtSpot's own Spotter, white-labelled, with usage limits on. It isn't in the nav: open the avatar menu (top right) and choose **Spotter usage limits demo**. The rest of the app, including the Shuttle drawer, is unchanged. The panel on the right is the presenter panel; everything in it is the real API, not a mock.

## Before you start

- Sign in, avatar menu → **Spotter usage limits demo**, presenter panel on the **Scenario** tab.
- Plan **Growth (500)**. Click **1. A healthy plan** so the pool exists and the counter shows about 20 of 500.
- Spotter 3 switch on (Settings tab). Chat history in the left sidebar.
- Don't send questions with the starter chips if you want to show the upgrade links: a conversation started programmatically doesn't fire the Upgrade event yet (see *Known edges*). Type the question, or start a new chat.
- Leaving the page puts the plan and question count back exactly as they were, so the rest of the demo is unaffected.

## The story in one line

"Putting Spotter in your product is great for users, but every question costs you money. Now you can cap questions per org, user group or user, show the user where they stand, and sell them more when they run out."

## 1. Set the scene (1 min)

**Show:** the demo page. Point at the sidebar, the question bar, the counter ring.

**Say:** "This is ThoughtSpot's native Spotter, embedded in Storeloom, dressed in Storeloom's brand: name, logo, colours, wording. Conversation history is on, so users keep their past chats. Until now there was nothing to stop one customer asking unlimited questions at your expense."

## 2. The end-user experience (2 min)

**Show:** click the **counter ring**. It opens the Usage limit card: Questions 20 / 500.

**Say:** "Every user sees where they stand. No support ticket, no surprise. This is built in; you turn it on with one config block."

**Show:** Code tab → **Embed**. Point at the highlighted `spotterUsageLimitConfig`.

**Say:** "That orange block is the whole feature on the front end. You choose when the counter appears, whether there's a warning banner and a limit banner, and whether to show an Upgrade button." Click a value (for example the counter mode) and let the embed reload. "These are live: I'm changing the real embed."

## 3. Running low (2 min)

**Show:** Scenario → **2. Almost out**. Status card turns amber: 497 of 500.

**Say:** "Three left. The user gets a heads-up before they hit a wall, so the limit is never a surprise." Point at the warning banner in the embed.

**Show:** API log tab. Point at the call, its time and duration. "What just happened: my app called ThoughtSpot's usage-data API from the backend, set this user's pool, and the embed picked it up."

## 4. The limit (2 min)

**Show:** Scenario → **3. At the limit**. Banner: "You've hit your usage limit". Type a question: the box won't submit.

**Say:** "At the limit questions are blocked. Hiding the banner doesn't change that: the block is enforced by ThoughtSpot, not by your UI. And this is exactly where you sell more."

## 5. Upgrade: where monetization happens (2 min)

**Show:** click **Upgrade plan** in the banner (or in the counter popover).

**Say:** "ThoughtSpot doesn't do billing. The button fires an event, `SpotterUsageLimitUpgrade`, with the usage count, the limit and a status. Your app decides what happens next." The Storeloom plan comparison opens. Code tab → **Upgrade** shows the handler and the payload under "Upgrade events received".

**Show:** pick **Scale**.

**Say:** "Your billing runs. On success your backend raises the limit with one API call and refreshes the counter, no page reload." The status card moves to 500 of 2,500. API log shows the update call with its time.

**Land it:** "A plan is a pool of questions. Growth 500, Scale 2,500, Enterprise unlimited. That's your plan tiers and your upsell, with your margins protected."

## 6. Operating it (1 min)

**Show:** Scenario → **New billing cycle**, then Code tab → **New cycle** and **Monitor**.

**Say:** "Usage doesn't reset by itself, so you reset each pool on your billing cycle with one call. And you can read any user's usage and what's left at any time. There's no admin screen: it's REST, so it plugs into the billing system you already have."

## 7. How it's wired (1 min)

**Show:** Code tab → **Set a limit**. Point at the endpoint and fields.

**Say:** "Four REST endpoints: `search`, `update`, `delete`, and `user`. Pools can be per org, per user group or per user; you pick one scope per cluster. Pools add together, and a user with an unlimited pool is never charged. Admin calls run from your backend with an admin token; the user's own `user` call works with their own token."

## Questions you'll get

- **"Can we charge per question?"** Pools are counts, so yes: sell packs, or meter on your own and push the limit with `update`.
- **"Per customer or per user?"** Either. Org, user group or user; one scope per cluster. Group pools add up across a user's groups.
- **"Does it reset monthly?"** Not automatically. Reset with `usage: 0` on your billing cycle.
- **"Is there an admin UI?"** No, API only.
- **"What do I need?"** ThoughtSpot Cloud 26.11.0.cl and Visual Embed SDK 1.53 or later.
- **"Is the API GA?"** Yes, even though the docs still label it Beta.
- **"Host-managed counting?"** Coming: your app keeps the count and tells the embed what to show. Mention it as roadmap only.
- **"Does it work in the new Spotter?"** Spotter on Liveboards and full app embed are coming. This page uses the new Spotter experience in the Spotter embed.

## Known edges (don't hit these live)

- **Upgrade links after a programmatic question.** A conversation started with a starter chip while you still have questions left doesn't fire the Upgrade event. Start a new chat or reopen one from history first.
- **Classic experience.** With the Spotter 3 switch off there is no counter or banner. Keep it on.
- **At the limit,** the starter chips are disabled, because the embed doesn't block questions sent that way. That is deliberate.
- **Typing at the limit** is not blocked: the box accepts text and only the send button is disabled. That is ThoughtSpot's behavior.
- **Shared cluster.** The first pool sets the metering scope for the whole cluster (`USER` here). Don't change it during a demo.
- **Who runs it:** each signed-in person gets their own throwaway test user (`spotter_monetization_TSE_tmp_<id>`), so parallel demos never collide and the counter you see is yours. Leave the page and come back within a day and the pool is as you left it. Idle users are deleted after 24h.
- **Admin calls** need `THOUGHTSPOT_ADMIN_USERNAME` on the server, or a signed-in cluster administrator. A 403 in the API log means that.

## Reset between demos

Scenario → pick Growth → **1. A healthy plan**.
