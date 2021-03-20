const MongoDB = require('mongodb');
const {ReadPreference, Timestamp } = require('mongodb');
const fs = require('fs');
const { Kafka } = require('kafkajs');
const AWS = require('aws-sdk');
const BSON = require('bson');


exports.handler = async (event) => {

  let client;
  let producer;
  let masterUser= process.env.DOCDB_USER;
  let masterPassword=process.env.DOCDB_PASS;
  let kafkaTopicName=process.env.KAFKA_TOPIC_NAME;
  let maxWatchSeconds=process.env.MAX_WATCH_SECONDS;
  const dbName="blogdb";
  const checkpointColName="checkpoints";
  const changeColName="blogcollection";
  var lastProcessedToken=null;
  var bson = new BSON();
  try {
    //get MSK bootstrap brokers.
    const mskBrokers= await getMskBootstrapBrokers();
    //connect to Kafka
    const kafka = new Kafka({
      clientId: 'blog-publisher-app',
      brokers: mskBrokers.BootstrapBrokerString.split(',')
    });

    producer = kafka.producer();
    await producer.connect();
    console.log("Connected to Kafka");  
    //connect to DocumentDB
    client = await MongoDB.MongoClient.connect(
    'mongodb://'+masterUser+':'+masterPassword+'@' + process.env.DOCDB_CLUSTER_ENDPOINT + ':27017/?ssl=true&ssl_ca_certs=rds-combined-ca-bundle.pem&replicaSet=rs0&retryWrites=false',
        {
          sslValidate: true,
          sslCA:fs.readFileSync(__dirname + '/rds-combined-ca-bundle.pem'),
          useNewUrlParser: true,
          useUnifiedTopology: true
        });
    const mydb = await client.db(dbName);
       console.log("Connected to DocumentDB and initialized. Fetching the resume token");
       let myDocument = await mydb.collection(checkpointColName).findOne();
       console.log("Resuming from token: " + myDocument.checkpoint);

       let options=null;
       console.log(myDocument.checkpoint);
       if(myDocument.checkpoint==0)
        options = {
          fullDocument: 'updateLookup'
       };
       else
        options = {
          resumeAfter: myDocument.checkpoint,
          fullDocument: 'updateLookup'
       };
       console.log(options);
       const changeStream = mydb.collection(changeColName).watch([], options);

       setTimeout(() => {
        console.log("Closing the change stream");
        changeStream.close();
        }, maxWatchSeconds*1000);
       
       console.log('Waiting for changes');
       while (await changeStream.hasNext()){
          const change = await changeStream.next();
          if(change!=null){
              lastProcessedToken=changeStream.resumeToken;
               console.log("Last processed token " + lastProcessedToken);
              if(change.operationType==='insert' || change.operationType==='update' || change.operationType==='delete'){
                await producer.send({
                  topic: kafkaTopicName,
                  acks: 1,
                  messages: [
                    { value: JSON.stringify(change.fullDocument)},
                  ],
                });
              }
         }
       }//while
       console.log("watch over"+ lastProcessedToken);
      //watch is over. Checkpoint the resume point.
      if(lastProcessedToken!=null){
          const updateDoc = {
              $set: {
                "checkpoint":lastProcessedToken
              }
            };
          await mydb.collection('checkpoints').updateOne({_id:1},updateDoc,{ upsert: false });
          console.log('Updated the checkpoint');
      }
  }
  catch(err){
    console.log(err.stack);
  }
  finally {
      client && await client.close();
      producer && await producer.disconnect();
  }
};

function getMskBootstrapBrokers () {
    const kafkaSdk = new AWS.Kafka();
    return new Promise ((resolve,reject) => {
      var params = {
        ClusterArn: process.env.MSK_BROKER_ARN
      };
      console.log("calling");
      kafkaSdk.getBootstrapBrokers(params, function(err, data) {
        if (err) {
        console.log(err);
        reject(err);
         }// an error occurred
        else  {
          console.log(data);
          resolve(data);
        } // successful response
      });
});
};