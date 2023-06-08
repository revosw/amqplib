import { amqp } from "../";

(async () => {
  let connection;
  try {
    connection = await amqp.connect();
    const channel = await connection.createConfirmChannel();

    for (let i=0; i < 20; i++) {
      channel.publish('amq.topic', 'whatever', Buffer.from('blah'));
    };

    await channel.waitForConfirms();
    console.log('All messages done');
    await channel.close();
  } catch (err) {
    console.warn(err);
  } finally {
    if (connection) await connection.close();
  }
})();
